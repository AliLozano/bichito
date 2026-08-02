import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Character } from "../components/Character";
import { PetLabel } from "./PetLabel";
import type { CharacterId, Pose } from "../lib/characters";

// A pet rendered purely from a friend's stream. Used so the OWNER sees their pet
// bounce on a friend's screen (mirrored via `peer-petpos`), and vice versa.
const SIZE = 56;

export function RemotePet({
  character,
  from,
  owner,
  label,
}: {
  character: CharacterId;
  from: string; // the peer streaming the position (the screen it's bouncing on)
  owner: string; // which pet
  label?: string;
}) {
  const [, force] = useState(0);
  const st = useRef({ x: 0, y: 0, flip: false, pose: "fall" as Pose, has: false });

  useEffect(() => {
    const un = listen<{ from: string; owner: string; x: number; y: number; flip: boolean; pose: string }>(
      "peer-petpos",
      (e) => {
        if (e.payload.from !== from || e.payload.owner !== owner) return;
        const s = st.current;
        s.x = e.payload.x * window.innerWidth;
        s.y = e.payload.y * window.innerHeight;
        s.flip = e.payload.flip;
        s.pose = e.payload.pose as Pose;
        s.has = true;
        force((n) => (n + 1) & 0xffff);
      }
    );
    return () => {
      un.then((f) => f());
    };
  }, [from, owner]);

  const s = st.current;
  if (!s.has) return null;

  return (
    <div
      style={{
        position: "fixed",
        left: s.x,
        top: s.y,
        width: SIZE,
        height: SIZE,
        pointerEvents: "none",
        filter: "drop-shadow(0 2px 2px rgba(0,0,0,0.35))",
      }}
    >
      {label && <PetLabel name={label} />}
      <Character id={character} pose={s.pose} size={SIZE} flip={s.flip} />
    </div>
  );
}
