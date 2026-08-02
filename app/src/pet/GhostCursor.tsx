import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Character } from "../components/Character";
import { GhostArrow } from "./GhostArrow";
import { GripMeter } from "./GripMeter";
import type { CharacterId } from "../lib/characters";

// Grabber side: my pet hangs on a friend's cursor. I see a ghost of THEIR cursor
// (streamed live) with MY bichito clinging to it — a mirror of their screen — plus
// a grip meter (their grip level). I stream MY cursor back so they see my ghost
// approaching (why the grip tightens). When the grab ends, I hand my bichito off
// as a loose, grabbable pet that drops onto my screen.

const R = 200; // grab zone (px): being NEAR the ghost counts (it's a moving target)
const SIZE = 56;
const OFFSET_Y = 12;

export function GhostCursor({
  from,
  character,
  onEnd,
}: {
  from: string;
  character: CharacterId;
  onEnd: () => void;
}) {
  const [, force] = useState(0);
  const st = useRef({
    gx: window.innerWidth / 2,
    gy: window.innerHeight / 2,
    has: false,
    mx: 0,
    my: 0,
    pmx: 0,
    pmy: 0,
    speed: 0,
    lastPeer: performance.now(),
    lastGrip: 0,
    lastLog: 0,
    gripping: false,
    hold: 1,
    t: 0,
  });

  useEffect(() => {
    let raf = 0;
    let ended = false;

    invoke("cursor_feed_start", { peer: from }).catch(() => {});

    const unPeer = listen<{ from: string; x: number; y: number }>("peer-cursor", (e) => {
      if (e.payload.from !== from) return;
      const s = st.current;
      s.gx = e.payload.x * window.innerWidth;
      s.gy = e.payload.y * window.innerHeight;
      s.has = true;
      s.lastPeer = performance.now();
    });
    const unLocal = listen<{ nx: number; ny: number }>("local-cursor", (e) => {
      const s = st.current;
      const nx = e.payload.nx * window.innerWidth;
      const ny = e.payload.ny * window.innerHeight;
      // my cursor speed (px/s) — rubbing over the ghost grips harder than resting
      const sp = Math.hypot(nx - s.mx, ny - s.my) / 0.022;
      s.speed = s.speed * 0.6 + sp * 0.4;
      s.mx = nx;
      s.my = ny;
    });
    const unHold = listen<{ from: string; level: number }>("peer-hold", (e) => {
      if (e.payload.from === from) st.current.hold = e.payload.level;
    });
    const unRel = listen<{ from: string }>("peer-released", (e) => {
      if (e.payload.from === from) finish();
    });

    const finish = () => {
      if (ended) return;
      ended = true;
      invoke("cursor_feed_stop").catch(() => {});
      onEnd(); // the pet now bounces on the target's screen (server-driven)
    };

    const loop = (now: number) => {
      const s = st.current;
      s.t += 1;
      if (s.has) {
        const d = Math.hypot(s.mx - s.gx, s.my - s.gy);
        s.gripping = d < R;
        // reinforce by CLOSENESS: keep your cursor ON the ghost to hold on
        // closeness gates it; the SPEED of rubbing over the ghost weighs most
        const move = 0.25 + 0.75 * Math.min(s.speed / 800, 1);
        const strength = s.gripping ? (1 - d / R) * move : 0;
        if (s.gripping && now - s.lastGrip > 40) {
          s.lastGrip = now;
          invoke("peer_grip", { to: from, strength }).catch(() => {});
        }
        if (now - s.lastLog > 200) {
          s.lastLog = now;
          invoke("dbg_log", {
            line: `GRABBER dist=${Math.round(d)}/R${R} speed=${Math.round(
              s.speed
            )} move=${move.toFixed(2)} strengthSent=${strength.toFixed(
              2
            )} meter(theirGrip)=${s.hold.toFixed(2)}`,
          }).catch(() => {});
        }
        if (now - s.lastPeer > 2500) return finish();
      }
      force((n) => (n + 1) & 0xffff);
      if (!ended) raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      unPeer.then((f) => f());
      unLocal.then((f) => f());
      unHold.then((f) => f());
      unRel.then((f) => f());
      if (!ended) invoke("cursor_feed_stop").catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from]);

  const s = st.current;
  if (!s.has) return null;
  const sway = Math.sin(s.t * 0.18) * (s.gripping ? 10 : 5);

  return (
    <>
      <GhostArrow x={s.gx} y={s.gy} glow={s.gripping} />
      <GripMeter level={s.hold} x={s.gx} y={s.gy + OFFSET_Y - 16} />
      <div
        style={{
          position: "fixed",
          left: s.gx - SIZE / 2,
          top: s.gy + OFFSET_Y,
          width: SIZE,
          height: SIZE,
          pointerEvents: "none",
          transform: `rotate(${sway}deg)`,
          filter: "drop-shadow(0 2px 2px rgba(0,0,0,0.35))",
        }}
      >
        <Character id={character} pose="hang" size={SIZE} />
      </div>
    </>
  );
}
