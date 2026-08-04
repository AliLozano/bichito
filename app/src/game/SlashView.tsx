import type { Slash } from "./types";
import { SPRITE_PX } from "../pet/sim";

// A nail swing/art. A normal swing is a quick white crescent sweeping in its
// direction; a charged Art is bigger and tinted; Cyclone is a spinning ring. Sized
// from the swing's radius, positioned at its px center (computed by the engine),
// fading over its own duration.
const ROT: Record<Slash["dir"], number> = { right: 0, down: 90, left: 180, up: -90 };

export function SlashView({ slash }: { slash: Slash }) {
  const life = Math.min(1, slash.t / slash.duration); // 0 -> 1 over its lifetime
  const op = (1 - life) * 0.95;
  const box = SPRITE_PX * slash.radius * 2.4; // bounding box scales with hitbox
  const color = slash.clashed
    ? "#fde68a"
    : slash.kind === "cyclone"
    ? "#fcd34d"
    : slash.kind === "nail"
    ? "#e0f2fe"
    : "#bae6fd";
  const glow = slash.clashed ? "rgba(253,230,138,0.9)" : "rgba(186,230,253,0.8)";
  const common = {
    position: "fixed" as const,
    left: slash.cx - box / 2,
    top: slash.cy - box / 2,
    width: box,
    height: box,
    pointerEvents: "none" as const,
    opacity: op,
    // a soft DARK halo so the light blade stays visible on white/light backgrounds,
    // plus the colored glow for arts/clash.
    filter: `drop-shadow(0 0 2px rgba(0,0,0,0.85)) drop-shadow(0 0 4px rgba(0,0,0,0.55))${
      slash.kind !== "nail" || slash.clashed ? ` drop-shadow(0 0 6px ${glow})` : ""
    }`,
  };
  const OUTLINE = "rgba(15,23,42,0.9)"; // dark edge drawn under the blade

  if (slash.radial) {
    // Cyclone: a spinning double-arc ring around the pet
    const spin = life * 360;
    const w = 7 - 4 * life;
    return (
      <div style={{ ...common, transform: `rotate(${spin}deg)` }}>
        <svg width={box} height={box} viewBox="0 0 100 100">
          <path d="M50 8 A42 42 0 0 1 92 50" fill="none" stroke={OUTLINE} strokeWidth={w + 3} strokeLinecap="round" />
          <path d="M50 92 A42 42 0 0 1 8 50" fill="none" stroke={OUTLINE} strokeWidth={w + 3} strokeLinecap="round" />
          <path d="M50 8 A42 42 0 0 1 92 50" fill="none" stroke={color} strokeWidth={w} strokeLinecap="round" />
          <path d="M50 92 A42 42 0 0 1 8 50" fill="none" stroke={color} strokeWidth={w} strokeLinecap="round" />
        </svg>
      </div>
    );
  }

  const scale = 0.7 + life * 0.5; // sweeps outward
  const w = 6 - 3.5 * life;
  return (
    <div style={{ ...common, transform: `rotate(${ROT[slash.dir]}deg) scale(${scale})` }}>
      <svg width={box} height={box} viewBox="0 0 46 46">
        <path d="M12 5 Q42 23 12 41" fill="none" stroke={OUTLINE} strokeWidth={w + 3} strokeLinecap="round" />
        <path d="M12 5 Q42 23 12 41" fill="none" stroke={color} strokeWidth={w} strokeLinecap="round" />
        <path d="M12 5 Q42 23 12 41" fill="none" stroke="#ffffff" strokeWidth={2.4 - 1.8 * life} strokeLinecap="round" />
      </svg>
    </div>
  );
}
