import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Character } from "../components/Character";
import { GhostArrow } from "./GhostArrow";
import { GripMeter } from "./GripMeter";
import type { Spawn } from "./Pet";
import type { CharacterId, Pose } from "../lib/characters";

// Target side: a friend's pet fell onto MY real cursor and is hanging on.
// - falls from above onto the cursor, then hangs following it
// - moving fast drains grip -> it slips, drops and walks off
// - `peer-grip` (the grabber hovering over my ghost) reinforces the grip
// The Rust cursor feed streams my normalized cursor to the grabber for the ghost.

const SIZE = 56;
const GRAVITY = 2600; // px/s^2
const OFFSET_Y = 12; // hangs a bit below the cursor tip
const MAX_HANG_S = 60; // let it hang a good long while if you don't shake it off
const NEAR_R = 200; // grabber ghost this close to my cursor = "gripping harder"

type Phase = "falling" | "hanging";

export function GrabPet({
  from,
  character,
  fromName,
  onEnd,
}: {
  from: string;
  character: CharacterId;
  fromName: string;
  onEnd: (drop: Spawn) => void;
}) {
  const [, force] = useState(0);
  const st = useRef({
    phase: "falling" as Phase,
    x: window.innerWidth / 2,
    y: -SIZE,
    vy: 0,
    cx: window.innerWidth / 2,
    cy: window.innerHeight / 2,
    pcx: window.innerWidth / 2,
    pcy: window.innerHeight / 2,
    grip: 1,
    hold: 0,
    pvx: 0,
    pvy: 0,
    accel: 0,
    t: 0,
    frame: 0,
    flip: false,
    walkTarget: 0,
    lastHold: 0,
    lastLog: 0,
    // grabber's ghost cursor (so I can SEE why the grip tightens)
    agx: 0,
    agy: 0,
    aghas: false,
  });

  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    let ended = false;

    // Begin streaming my cursor to the grabber (for their ghost) + local feed.
    invoke("cursor_feed_start", { peer: from }).catch(() => {});

    const unCur = listen<{ nx: number; ny: number }>("local-cursor", (e) => {
      const s = st.current;
      const nx = e.payload.nx * window.innerWidth;
      const ny = e.payload.ny * window.innerHeight;
      const sdt = 0.022; // poller interval (~45fps)
      const vx = (nx - s.cx) / sdt;
      const vy = (ny - s.cy) / sdt;
      // ACCELERATION (change in velocity): constant motion barely drains grip,
      // only sharp shakes/jerks do.
      s.accel = s.accel * 0.6 + Math.hypot(vx - s.pvx, vy - s.pvy) * 0.4;
      s.pvx = vx;
      s.pvy = vy;
      s.cx = nx;
      s.cy = ny;
    });
    const unGrip = listen<{ from: string; strength: number }>("peer-grip", (e) => {
      if (e.payload.from !== from) return;
      // grabber's closeness (how ON my ghost they are) feeds the reinforcement
      st.current.hold = Math.min(1, st.current.hold + e.payload.strength * 0.28);
    });
    // the grabber's live cursor -> render their ghost approaching mine
    const unGhost = listen<{ from: string; x: number; y: number }>("peer-cursor", (e) => {
      if (e.payload.from !== from) return;
      const s = st.current;
      s.agx = e.payload.x * window.innerWidth;
      s.agy = e.payload.y * window.innerHeight;
      s.aghas = true;
    });

    const finish = (drop: Spawn) => {
      if (ended) return;
      ended = true;
      invoke("peer_released", { to: from }).catch(() => {});
      invoke("cursor_feed_stop").catch(() => {});
      onEnd(drop);
    };

    const loop = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      const s = st.current;
      s.t += dt;

      switch (s.phase) {
        case "falling":
          s.vy += GRAVITY * dt;
          s.y += s.vy * dt;
          s.x += (s.cx - s.x) * Math.min(1, dt * 6);
          if (s.y >= s.cy - OFFSET_Y) {
            s.phase = "hanging";
            s.vy = 0;
          }
          break;
        case "hanging": {
          // cling to the cursor with a little lag
          s.x += (s.cx - s.x) * Math.min(1, dt * 18);
          s.y += (s.cy + OFFSET_Y - s.y) * Math.min(1, dt * 18);
          // BATTLE: grip drains with my cursor's ACCELERATION (sharp shakes), not
          // steady speed — moving at a constant pace barely loosens it. The
          // grabber's movement (peer-grip -> hold) pushes it back up.
          const decayBase = 0.008; // move calmly/steady -> hangs ~2 minutes
          const decayAccel = Math.min(s.accel / 15000, 1) * 3.5; // only jerks shed it fast
          s.hold = Math.max(0, s.hold - 1.6 * dt); // reinforcement fades if they leave the ghost
          s.grip += (s.hold * 2.0 - decayAccel - decayBase) * dt; // closeness pushes UP hard
          s.grip = Math.max(0, Math.min(1, s.grip));
          // stream my grip level to the grabber (drives their meter)
          if (now - s.lastHold > 120) {
            s.lastHold = now;
            invoke("peer_hold", { to: from, level: s.grip }).catch(() => {});
          }
          if (s.grip <= 0 || s.t > MAX_HANG_S) {
            // hand off to a loose, grabbable pet that drops onto my screen
            finish({
              x: s.x - SIZE / 2,
              y: s.y,
              vx: (Math.random() - 0.5) * 300,
              vy: 120,
            });
          }
          break;
        }
      }

      if (s.phase === "hanging" && now - s.lastLog > 200) {
        s.lastLog = now;
        const down = Math.min(s.accel / 15000, 1) * 3.5;
        invoke("dbg_log", {
          line: `TARGET grip=${s.grip.toFixed(2)} hold=${s.hold.toFixed(2)} accel=${Math.round(
            s.accel
          )} DOWN(accel)=${down.toFixed(2)} UP(hold*1.5)=${(s.hold * 1.5).toFixed(2)}`,
        }).catch(() => {});
      }
      force((n) => (n + 1) & 0xffff);
      if (!ended) raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      unCur.then((f) => f());
      unGrip.then((f) => f());
      unGhost.then((f) => f());
      if (!ended) invoke("cursor_feed_stop").catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from]);

  const s = st.current;
  const pose: Pose = s.phase === "hanging" ? "hang" : "fall";
  const near = s.aghas && Math.hypot(s.agx - s.cx, s.agy - s.cy) < NEAR_R;
  const sway = s.phase === "hanging" ? Math.sin(s.t * 8) * (near ? 10 : 6) : 0;

  return (
    <>
      {/* my friend's ghost cursor closing in — WHY the grip tightens */}
      {s.aghas && <GhostArrow x={s.agx} y={s.agy} glow={near} />}
      {/* grip meter — how tightly THIS pet is holding my cursor */}
      {(s.phase === "hanging" || s.phase === "falling") && (
        <GripMeter level={s.grip} x={s.x} y={s.y - 16} />
      )}
      <div
        style={{
          position: "fixed",
          left: s.x - SIZE / 2,
          top: s.y,
          width: SIZE,
          height: SIZE,
          pointerEvents: "none",
          transform: `rotate(${sway}deg)`,
          filter: "drop-shadow(0 2px 2px rgba(0,0,0,0.35))",
        }}
      >
      {s.phase === "hanging" && (
        <div
          style={{
            position: "absolute",
            top: -18,
            left: "50%",
            transform: "translateX(-50%)",
            whiteSpace: "nowrap",
            fontSize: 11,
            fontWeight: 700,
            color: "#fff",
            background: "rgba(244,114,182,0.9)",
            padding: "1px 6px",
            borderRadius: 8,
          }}
        >
          {fromName || "alguien"} 🐾
        </div>
      )}
      <Character id={character} pose={pose} size={SIZE} flip={s.flip} frame={s.frame} />
      </div>
    </>
  );
}
