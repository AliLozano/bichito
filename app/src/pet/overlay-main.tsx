import { useEffect, useRef, useState } from "react";
import ReactDOM from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Sim, SPRITE_PX } from "./sim";
import type { Env } from "./env";
import { PetView } from "./PetView";
import { StatsHud } from "./StatsHud";
import { GameEngine } from "../game/engine";
import { SlashView } from "../game/SlashView";
import { setVolume, resumeAudio } from "../game/sound";
import { CursorGhost } from "./CursorGhost";
import { check as checkUpdate } from "@tauri-apps/plugin-updater";
import {
  loadProfile,
  loadConfig,
  loadLocal,
  type Profile,
  type WorldConfig,
  type LocalSettings,
} from "../lib/store";
import "../styles.css";

// The overlay drives a single shared "pet world" Sim: pets I control are
// simulated locally + broadcast ~20Hz; pets I don't control are predicted from
// snapshots. Either player can grab/throw any pet (control handoff). Cursors
// (ghosts) are only shown to others while interacting. Everything is normalized
// (0..1) and converted to pixels only here at render time.

// Sim + GameEngine are singletons across HMR reloads (avoids duplicate worlds).
// The Sim owns the pet world + transport; the GameEngine layers the minigame on
// top and is wired in as the Sim's `game` controller.
const g = window as unknown as { __bichitoSim?: Sim; __bichitoGame?: GameEngine };
// Browser Env: viewport = the window; transport = the Tauri `net_*`/`game_*` commands
// (which forward onto the shared WebSocket). The headless bot supplies its own Env
// (fixed screen + a direct WS) so it runs this exact Sim/GameEngine — no reimplementation.
const browserEnv: Env = {
  vw: () => window.innerWidth || 1,
  vh: () => window.innerHeight || 1,
  transport: {
    claim: (owner) => void invoke("net_claim", { owner }).catch(() => {}),
    snap: (s) => void invoke("net_snap", s as unknown as Record<string, unknown>).catch(() => {}),
    cursor: (x, y, active) => void invoke("net_cursor", { x, y, active }).catch(() => {}),
    bump: (owner, vx, vy) => void invoke("net_bump", { owner, vx, vy }).catch(() => {}),
    game: (data) => void invoke("net_game", { data }).catch(() => {}),
    focus: () => void invoke("game_focus").catch(() => {}),
    arm: () => void invoke("game_arm").catch(() => {}),
  },
};
const sim = g.__bichitoSim ?? (g.__bichitoSim = new Sim(browserEnv));
const game = g.__bichitoGame ?? (g.__bichitoGame = new GameEngine(sim));
sim.game = game;

function Overlay() {
  const [me, setMe] = useState<Profile | null>(null);
  const [showStats, setShowStats] = useState(false);
  const [, force] = useState(0);
  // local diagnostics (this device only): smoothed render FPS + last measured RTT.
  const stats = useRef({ fps: 0, rtt: -1 });

  useEffect(() => {
    invoke("set_clickthrough", { ignore: true }).catch(() => {});
    invoke("cursor_poll_start").catch(() => {});

    // Local FPS/latency HUD (toggled in the "Local" settings tab). Turning it on
    // starts the fast latency probe in Rust; off stops it.
    const applyStats = (on: boolean) => {
      setShowStats(on);
      stats.current.rtt = -1;
      invoke(on ? "net_ping_start" : "net_ping_stop").catch(() => {});
    };
    loadLocal().then((l) => {
      applyStats(l.showStats);
      setVolume(l.volume);
    });

    let profileReady = false;
    loadProfile().then((p) => {
      setMe(p);
      sim.setMe(p.id, p.name, p.character);
      profileReady = true;
      invoke<any[]>("get_world")
        .then((pets) => sim.onWorld(pets, performance.now()))
        .catch(() => {});
    });
    // adopt the shared group config (local default, then the server's if present)
    loadConfig().then((c) => sim.setConfig(c));
    invoke<WorldConfig | null>("get_config")
      .then((c) => c && sim.setConfig(c))
      .catch(() => {});
    // on startup, tell the tray if there's a newer version to install
    checkUpdate()
      .then((u) => u && invoke("update_available", { version: u.version }).catch(() => {}))
      .catch(() => {});

    // --- ingest from the server (via Rust presence events) ------------------
    const subs = [
      listen<{ nx: number; ny: number }>("local-cursor", (e) => {
        sim.myCursor.x = e.payload.nx;
        sim.myCursor.y = e.payload.ny;
      }),
      listen<any[]>("world", (e) => sim.onWorld(e.payload, performance.now())),
      listen<any>("peer-snap", (e) => sim.applySnap(e.payload, performance.now())),
      listen<{ owner: string; controller: string }>("peer-claim", (e) =>
        sim.onClaim(e.payload.owner, e.payload.controller)
      ),
      listen<{ from: string; x: number; y: number; active: boolean }>("peer-cursor", (e) =>
        sim.onCursor(e.payload.from, e.payload.x, e.payload.y, e.payload.active, performance.now())
      ),
      listen<{ owner: string; vx: number; vy: number }>("peer-bump", (e) =>
        sim.onBump(e.payload.owner, e.payload.vx, e.payload.vy)
      ),
      listen<{ from: string; data: any }>("peer-game", (e) =>
        game.onPeerEvent(e.payload.from, e.payload.data)
      ),
      listen<{ ms: number }>("rtt", (e) => (stats.current.rtt = e.payload.ms)),
      listen<LocalSettings>("local-settings", (e) => {
        applyStats(e.payload.showStats);
        setVolume(e.payload.volume);
      }),
      listen<{ target: string }>("leap", (e) => sim.leap(e.payload.target)),
      listen<WorldConfig>("config", (e) => sim.setConfig(e.payload)),
      // live profile change (new name/character) -> update my pet immediately
      listen<Profile>("profile-changed", (e) => {
        const p = e.payload;
        setMe(p);
        sim.setMe(p.id, p.name, p.character);
        const mine = sim.pets.get(sim.me);
        if (mine) {
          mine.character = p.character;
          mine.name = p.name;
        }
      }),
    ];

    // --- main loop ----------------------------------------------------------
    let raf = 0;
    let last = performance.now();
    let clickThrough = true;

    const loop = (now: number) => {
      const rawDt = (now - last) / 1000;
      const dt = Math.min(rawDt, 0.05);
      last = now;
      // smoothed FPS from the true frame interval (rawDt, before the physics clamp)
      if (rawDt > 0)
        stats.current.fps = stats.current.fps
          ? stats.current.fps * 0.9 + (1 / rawDt) * 0.1
          : 1 / rawDt;
      if (profileReady) sim.step(dt, now);

      // Capture the mouse only to GRAB a loose pet, or while dragging one. A pet
      // clinging to my cursor (oncursor) is NOT grabbable, so don't capture for it —
      // otherwise the overlay eats my scroll/clicks the whole time it's on me. The
      // grip shake works off the native cursor poller, so capture isn't needed.
      // arm capture with a GENEROUS radius (margin for clickthrough-toggle latency)
      const under = sim.petAt(sim.myCursor.x, sim.myCursor.y, SPRITE_PX * 0.95);
      const hovering = !!under && under.state !== "oncursor";
      let holding = false;
      for (const p of sim.pets.values())
        if (p.controller === sim.me && p.state === "held") holding = true;
      // while playing (keyboard control) keep the overlay captured + focused
      const wantCapture = game.active || hovering || holding;
      if (wantCapture === clickThrough) {
        clickThrough = !wantCapture;
        invoke("set_clickthrough", { ignore: !wantCapture }).catch(() => {});
      }

      // (Auto-leap removed: an un-controlled pet just wanders — less intrusive. It only
      // leaps when the user explicitly triggers it from the tray "Saltar sobre X".)

      force((n) => (n + 1) & 0xffff);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    // Input at the WINDOW level (not the div) so a mouseup is never missed: if the
    // pointer leaves the window or focus is lost mid-drag, blur/pointercancel still
    // release the pet — otherwise it'd stay glued to the cursor and the overlay
    // would keep capturing every click.
    const onDown = () => {
      // a click (or drag) while in combat (playing OR armed/ready) exits it, then
      // behaves normally (grab-to-drag).
      if (game.active || game.armed) game.leave();
      sim.charging = true;
      const p = sim.petAt(sim.myCursor.x, sim.myCursor.y);
      // Grab to drag (click or drag). If it's MY pet and I set it down gently (a soft
      // move or a plain click), it sleeps and gets "armed" (keyboard focus, mouse free)
      // — decided when it lands (Sim -> game.armOnPlace); the first key starts the
      // match. A hard/high throw just bounces, no arm.
      // A pet clinging to a cursor (oncursor) only comes off by shaking, not clicks.
      if (p && p.state !== "gone" && p.state !== "oncursor") sim.grab(p);
    };
    const release = () => {
      sim.charging = false;
      for (const p of sim.pets.values())
        if (p.controller === sim.me && p.state === "held") sim.releaseHeld(p);
    };
    // losing focus (clicked another app) drops anything held AND exits combat — the
    // pet returns to the social world (sleep/walk) and the mouse is free again.
    const onBlur = () => {
      release();
      if (game.active || game.armed) game.leave();
    };
    const KEYMAP: Record<string, keyof typeof game.input> = {
      ArrowLeft: "left",
      ArrowRight: "right",
      ArrowUp: "up",
      ArrowDown: "down",
    };
    const onKey = (down: boolean) => (e: KeyboardEvent) => {
      if (down && e.key === "Escape") {
        if (game.active || game.armed) game.leave();
        return;
      }
      // Space = nail: hold to charge a Nail Art, release to swing (a quick tap is a
      // normal aguijonazo). While armed, the first Space starts the match. `e.repeat`
      // guards held-key auto-fire.
      if (e.key === " ") {
        if (game.active || game.armed) e.preventDefault();
        if (down && !e.repeat) {
          resumeAudio();
          if (game.armed && !game.active) {
            game.enter();
            game.startCharge();
          } else if (game.active) {
            game.startCharge();
          }
        } else if (!down && game.active) {
          game.releaseCharge();
        }
        return;
      }
      const k = KEYMAP[e.key];
      if (!k) return;
      // a keyup ALWAYS clears its input, even when not controlling — otherwise a key
      // released while inactive stays latched and the pet drifts on the next enter().
      if (!down) {
        game.input[k] = false;
        return;
      }
      // the FIRST game key while armed (pet placed & sleeping) starts the match
      if (!game.active && game.armed) game.enter();
      if (!game.active) return;
      e.preventDefault();
      game.input[k] = true;
    };
    const kd = onKey(true);
    const ku = onKey(false);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("mouseup", release);
    window.addEventListener("blur", onBlur);
    window.addEventListener("pointercancel", release);
    window.addEventListener("keydown", kd);
    window.addEventListener("keyup", ku);

    return () => {
      cancelAnimationFrame(raf);
      subs.forEach((s) => s.then((f) => f()));
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("mouseup", release);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("pointercancel", release);
      window.removeEventListener("keydown", kd);
      window.removeEventListener("keyup", ku);
    };
  }, []);

  if (!me) return null;

  return (
    <div style={{ position: "fixed", inset: 0, cursor: "default" }}>
      {showStats && <StatsHud fps={stats.current.fps} rtt={stats.current.rtt} />}
      {(() => {
        // health bars only during a real duel (≥2 pets in a match)
        const duel = [...sim.pets.values()].filter((p) => p.state === "play").length >= 2;
        return [...sim.pets.values()].map((p) => (
          <PetView
            key={"pet:" + p.owner}
            pet={p}
            sim={sim}
            mine={p.owner === me.id}
            flash={game.isStunned(p.owner, performance.now())}
            charge={p.owner === me.id ? game.chargeLevel(performance.now()) : 0}
            duel={duel}
          />
        ));
      })()}
      {game.slashes.map((s) => (
        <SlashView key={"s:" + s.id} slash={s} />
      ))}
      {[...sim.cursors.entries()]
        .filter(([id]) => id !== me.id)
        .map(([id, c]) => (
          <CursorGhost key={"cur:" + id} cursor={c} />
        ))}
    </div>
  );
}

const container = document.getElementById("overlay")!;
const store = window as unknown as { __bichitoOverlayRoot?: ReactDOM.Root };
const root =
  store.__bichitoOverlayRoot ?? (store.__bichitoOverlayRoot = ReactDOM.createRoot(container));
root.render(<Overlay />);
