import { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Sim } from "./sim";
import { PetView } from "./PetView";
import { CursorGhost } from "./CursorGhost";
import { loadProfile, type Profile } from "../lib/store";
import "../styles.css";

// The overlay drives a single shared "pet world" Sim: pets I control are
// simulated locally + broadcast ~20Hz; pets I don't control are predicted from
// snapshots. Either player can grab/throw any pet (control handoff). Cursors
// (ghosts) are only shown to others while interacting. Everything is normalized
// (0..1) and converted to pixels only here at render time.

// Sim is a singleton across HMR reloads (avoids duplicate worlds).
const g = window as unknown as { __bichitoSim?: Sim };
const sim = g.__bichitoSim ?? (g.__bichitoSim = new Sim());

function Overlay() {
  const [me, setMe] = useState<Profile | null>(null);
  const [, force] = useState(0);

  useEffect(() => {
    invoke("set_clickthrough", { ignore: true }).catch(() => {});
    invoke("cursor_poll_start").catch(() => {});

    let profileReady = false;
    loadProfile().then((p) => {
      setMe(p);
      sim.setMe(p.id, p.name, p.character);
      profileReady = true;
      invoke<any[]>("get_world")
        .then((pets) => sim.onWorld(pets, performance.now()))
        .catch(() => {});
    });

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
      listen<{ target: string }>("leap", (e) => sim.leap(e.payload.target)),
    ];

    // --- main loop ----------------------------------------------------------
    let raf = 0;
    let last = performance.now();
    let clickThrough = true;
    let nextAutoLeap = performance.now() + 30000 + Math.random() * 40000;

    const loop = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      if (profileReady) sim.step(dt, now);

      // Capture the mouse only to GRAB a loose pet, or while dragging one. A pet
      // clinging to my cursor (oncursor) is NOT grabbable, so don't capture for it —
      // otherwise the overlay eats my scroll/clicks the whole time it's on me. The
      // grip shake works off the native cursor poller, so capture isn't needed.
      const under = sim.petAt(sim.myCursor.x, sim.myCursor.y);
      const hovering = !!under && under.state !== "oncursor";
      let holding = false;
      for (const p of sim.pets.values())
        if (p.controller === sim.me && p.state === "held") holding = true;
      const wantCapture = hovering || holding;
      if (wantCapture === clickThrough) {
        clickThrough = !wantCapture;
        invoke("set_clickthrough", { ignore: !wantCapture }).catch(() => {});
      }

      // Occasionally leap my pet onto a random online friend.
      if (profileReady && now > nextAutoLeap) {
        nextAutoLeap = now + 30000 + Math.random() * 40000;
        const others = [...sim.pets.values()].filter(
          (p) => p.owner !== sim.me && p.state !== "gone"
        );
        const mine = sim.pets.get(sim.me);
        if (others.length && mine && mine.state === "walk") {
          sim.leap(others[Math.floor(Math.random() * others.length)].owner);
        }
      }

      force((n) => (n + 1) & 0xffff);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    // Input at the WINDOW level (not the div) so a mouseup is never missed: if the
    // pointer leaves the window or focus is lost mid-drag, blur/pointercancel still
    // release the pet — otherwise it'd stay glued to the cursor and the overlay
    // would keep capturing every click.
    const onDown = () => {
      sim.charging = true;
      const p = sim.petAt(sim.myCursor.x, sim.myCursor.y);
      // a pet clinging to a cursor (oncursor) only comes off by shaking, not clicks
      if (p && p.state !== "gone" && p.state !== "oncursor") sim.grab(p);
    };
    const release = () => {
      sim.charging = false;
      for (const p of sim.pets.values())
        if (p.controller === sim.me && p.state === "held") sim.releaseHeld(p);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("mouseup", release);
    window.addEventListener("blur", release);
    window.addEventListener("pointercancel", release);

    return () => {
      cancelAnimationFrame(raf);
      subs.forEach((s) => s.then((f) => f()));
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("mouseup", release);
      window.removeEventListener("blur", release);
      window.removeEventListener("pointercancel", release);
    };
  }, []);

  if (!me) return null;

  return (
    <div style={{ position: "fixed", inset: 0, cursor: "default" }}>
      {[...sim.pets.values()].map((p) => (
        <PetView key={"pet:" + p.owner} pet={p} sim={sim} mine={p.owner === me.id} />
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
