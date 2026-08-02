import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Character } from "../components/Character";
import { PetLabel } from "./PetLabel";
import type { CharacterId, Pose } from "../lib/characters";

// A walking, grabbable pet on MY screen. Two ways it's born:
//   • ambient   — a friend's pet strolls in from an edge (loops forever)
//   • loose      — it just fell off a cursor (given a spawn pos+velocity); it
//                  lands, dusts off, wanders a bit, then leaves (one-shot).
// You can grab ANY of them with the mouse and throw it: it bounces off the edges,
// loses energy, and (if YOU threw it) fades away; then reappears later.
//
// Clicking works despite the click-through overlay: a shared counter toggles the
// OS click-through OFF while the cursor is over/holding a pet.

const SIZE = 56;
const FLOOR = 76;
const SPEED = 90;
const GRAVITY = 2400;
const WALK_FRAME_MS = 120;
const REST_MIN = 8000;
const REST_MAX = 22000;
const MAX_THROW_V = 2600;

// --- shared click-through arbitration across all pet instances ---------------
// A Set (not a counter) so double-adds/removes can't drift and leave the overlay
// stuck capturing the mouse (which would hide the real cursor everywhere).
const owners = new Set<number>();
let petSeq = 0;
function setInteract(id: number, on: boolean) {
  const was = owners.size;
  if (on) owners.add(id);
  else owners.delete(id);
  if (was === 0 && owners.size > 0) invoke("set_clickthrough", { ignore: false }).catch(() => {});
  else if (was > 0 && owners.size === 0) invoke("set_clickthrough", { ignore: true }).catch(() => {});
}

export interface Spawn {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

type Phase = "hidden" | "enter" | "hop" | "rest" | "leave" | "held" | "thrown" | "downed" | "fade";

function rand(min: number, max: number) {
  return min + Math.random() * (max - min);
}
function floorY() {
  return window.innerHeight - FLOOR - SIZE;
}

export function Pet({
  character,
  spawn,
  onGone,
  onLeave,
  streamTo,
  owner,
  label,
}: {
  character: CharacterId;
  spawn?: Spawn;
  onGone?: () => void;
  onLeave?: () => void; // it walked off / vanished from my screen (roaming handoff)
  streamTo?: string; // peer to mirror this pet's position to (owner watches the bounce)
  owner?: string;
  label?: string; // owner's name shown above the pet
}) {
  const [, force] = useState(0);
  const oneShot = !!spawn;
  const petId = useRef(0);
  if (petId.current === 0) petId.current = ++petSeq;
  const v = useRef({
    phase: "hidden" as Phase,
    x: -SIZE,
    y: floorY(),
    vx: 0,
    vy: 0,
    target: 0,
    flip: false,
    frame: 0,
    frameAcc: 0,
    pose: "idle" as Pose,
    timer: rand(600, 2000),
    hops: 0,
    opacity: 1,
    spin: 0,
    scale: 1,
    lastStream: 0,
    tossed: false, // thrown by me -> lie down and vanish (don't wander off)
    // input
    cx: 0,
    cy: 0,
    pcx: 0,
    pcy: 0,
    hover: false,
    held: false,
    offX: 0,
    offY: 0,
    counted: false,
    settle: 0,
  });

  useEffect(() => {
    const s = v.current;
    if (spawn) {
      // born loose: start falling from where it dropped
      s.phase = "thrown";
      s.x = spawn.x;
      s.y = spawn.y;
      s.vx = spawn.vx;
      s.vy = spawn.vy;
      s.settle = 0;
      s.opacity = 1;
    }

    let raf = 0;
    let last = performance.now();

    const wandering = (p: Phase) => p === "enter" || p === "leave" || p === "hop" || p === "rest";
    const endLife = () => {
      onLeave?.(); // tell the server it left my screen (roaming can re-home it)
      if (oneShot) onGone?.();
      else {
        s.phase = "hidden";
        s.pose = "idle";
        s.opacity = 1;
        s.timer = rand(REST_MIN, REST_MAX);
      }
    };

    const startStroll = () => {
      const w = window.innerWidth;
      const fromLeft = Math.random() < 0.5;
      s.x = fromLeft ? -SIZE : w;
      s.y = floorY();
      s.target = rand(w * 0.2, w * 0.8);
      s.flip = s.target < s.x;
      s.pose = "walk";
      s.opacity = 1;
      s.spin = 0; // stand upright when it walks back in
      s.scale = 1;
      s.phase = "enter";
    };
    const leave = () => {
      s.target = Math.random() < 0.5 ? -SIZE : window.innerWidth + SIZE;
      s.flip = s.target < s.x;
      s.pose = "walk";
      s.phase = "leave";
    };

    const walkStep = (dt: number) => {
      const dir = s.target > s.x ? 1 : -1;
      s.x += dir * SPEED * (dt / 1000);
      s.flip = dir < 0;
      s.frameAcc += dt;
      if (s.frameAcc >= WALK_FRAME_MS) {
        s.frameAcc = 0;
        s.frame ^= 1;
      }
      return Math.abs(s.x - s.target) < 3;
    };

    const step = (dtMs: number) => {
      const dt = dtMs / 1000;
      s.scale += (1 - s.scale) * Math.min(1, dt * 12); // ease pickup pop back to 1
      // freeze while hovered so it's easy to grab
      if (s.hover && !s.held && wandering(s.phase)) {
        s.pose = "idle";
        return;
      }
      switch (s.phase) {
        case "hidden":
          s.timer -= dtMs;
          if (s.timer <= 0) startStroll();
          break;
        case "rest":
          s.timer -= dtMs;
          if (s.timer <= 0) leave();
          break;
        case "enter":
          if (walkStep(dtMs)) {
            s.x = s.target;
            s.phase = "hop";
            s.hops = 2;
            s.pose = "jump";
            s.timer = 320;
          }
          break;
        case "leave":
          if (walkStep(dtMs)) endLife();
          break;
        case "hop":
          s.timer -= dtMs;
          if (s.timer <= 0) {
            if (s.pose === "jump") {
              s.pose = "idle";
              s.timer = 180;
            } else if (s.hops > 1) {
              s.hops--;
              s.pose = "jump";
              s.timer = 320;
            } else {
              s.phase = "rest";
              s.pose = "idle";
              s.timer = rand(2000, 5000);
            }
          }
          break;
        case "held": {
          s.x = s.cx + s.offX;
          s.y = s.cy + s.offY;
          const inst = { x: (s.cx - s.pcx) / Math.max(dt, 1e-3), y: (s.cy - s.pcy) / Math.max(dt, 1e-3) };
          s.vx = s.vx * 0.4 + inst.x * 0.6; // smoothed flick velocity
          s.vy = s.vy * 0.4 + inst.y * 0.6;
          s.pcx = s.cx;
          s.pcy = s.cy;
          s.pose = "hang";
          break;
        }
        case "thrown": {
          s.vy += GRAVITY * dt;
          s.x += s.vx * dt;
          s.y += s.vy * dt;
          s.spin += s.vx * dt * 0.5;
          const w = window.innerWidth;
          if (s.x < 0) {
            s.x = 0;
            s.vx = -s.vx * 0.7;
          } else if (s.x > w - SIZE) {
            s.x = w - SIZE;
            s.vx = -s.vx * 0.7;
          }
          if (s.y < 0) {
            s.y = 0;
            s.vy = -s.vy * 0.6;
          } else if (s.y > floorY()) {
            s.y = floorY();
            s.vy = -s.vy * 0.5;
            s.vx *= 0.8;
          }
          s.pose = "fall";
          const settled = s.y >= floorY() - 1 && Math.abs(s.vy) < 60 && Math.abs(s.vx) < 40;
          s.settle = settled ? s.settle + dtMs : 0;
          if (s.settle > 400) {
            if (s.tossed) {
              // I threw it: it stays lying at whatever angle it tumbled to (no snap,
              // no straightening) — still grabbable to toss again, then vanishes.
              s.phase = "downed";
              s.pose = "idle";
              s.timer = 4000;
            } else {
              // it fell off a cursor on its own: stand up and wander away
              s.spin = 0;
              s.phase = "rest";
              s.pose = "idle";
              s.timer = rand(1500, 3500);
            }
          }
          break;
        }
        case "downed":
          s.timer -= dtMs;
          if (s.timer <= 0) s.phase = "fade";
          break;
        case "fade":
          s.opacity -= dt / 0.6;
          if (s.opacity <= 0) {
            s.opacity = 0;
            endLife();
          }
          break;
      }
    };

    const loop = (now: number) => {
      const dt = Math.min(now - last, 50);
      last = now;
      step(dt);
      // mirror my position to the owner so they see this pet bounce too
      if (streamTo && owner && v.current.phase !== "hidden" && now - v.current.lastStream > 33) {
        v.current.lastStream = now;
        invoke("pet_pos", {
          to: streamTo,
          owner,
          x: v.current.x / window.innerWidth,
          y: v.current.y / window.innerHeight,
          flip: v.current.flip,
          pose: v.current.pose,
        }).catch(() => {});
      }
      force((n) => (n + 1) & 0xffff);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    const unCur = listen<{ nx: number; ny: number }>("local-cursor", (e) => {
      // while held, the native mousemove owns the cursor — don't fight it (jitter)
      if (s.held) return;
      s.cx = e.payload.nx * window.innerWidth;
      s.cy = e.payload.ny * window.innerHeight;
      const visible = s.phase !== "hidden";
      const pad = 14;
      const over =
        visible &&
        s.cx >= s.x - pad &&
        s.cx <= s.x + SIZE + pad &&
        s.cy >= s.y - pad &&
        s.cy <= s.y + SIZE + pad;
      s.hover = over;
      const want = over || s.held;
      if (want !== s.counted) {
        s.counted = want;
        setInteract(petId.current, want);
      }
    });

    const onMove = (e: MouseEvent) => {
      if (!s.held) return;
      s.cx = e.clientX;
      s.cy = e.clientY;
    };
    const onUp = () => {
      if (!s.held) return;
      s.held = false;
      s.phase = "thrown";
      s.tossed = true; // I threw it -> it will lie down and vanish, not wander
      s.vx = Math.max(-MAX_THROW_V, Math.min(MAX_THROW_V, s.vx));
      s.vy = Math.max(-MAX_THROW_V, Math.min(MAX_THROW_V, s.vy));
      s.settle = 0;
      if (s.counted && !s.hover) {
        s.counted = false;
        setInteract(petId.current, false);
      }
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);

    return () => {
      cancelAnimationFrame(raf);
      unCur.then((f) => f());
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      if (s.counted) {
        s.counted = false;
        setInteract(petId.current, false);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const s = v.current;
  if (s.phase === "hidden") return null;

  const onMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    s.held = true;
    s.phase = "held";
    s.cx = e.clientX;
    s.cy = e.clientY;
    s.pcx = e.clientX;
    s.pcy = e.clientY;
    s.offX = s.x - e.clientX;
    s.offY = s.y - e.clientY;
    s.vx = 0;
    s.vy = 0;
    s.scale = 1.25; // little "pop" when grabbed
    if (!s.counted) {
      s.counted = true;
      setInteract(petId.current, true);
    }
  };

  const interactive = s.hover || s.held;
  const lie = s.phase === "downed" || s.phase === "fade"; // knocked out, lying down

  return (
    <div
      onMouseDown={onMouseDown}
      style={{
        position: "fixed",
        left: s.x,
        top: s.y,
        width: SIZE,
        height: SIZE,
        opacity: s.opacity,
        pointerEvents: interactive ? "auto" : "none",
        // non-intrusive: never change the OS cursor icon (it's just a cute overlay)
        cursor: "inherit",
        // keep the angle it tumbled/fell to (grabbing it must NOT straighten it)
        transform: `rotate(${s.spin}deg) scale(${s.scale})`,
        filter: "drop-shadow(0 2px 2px rgba(0,0,0,0.35))",
      }}
    >
      {label && !lie && <PetLabel name={label} />}
      <Character id={character} pose={s.pose} size={SIZE} flip={s.flip} frame={s.frame} />
    </div>
  );
}
