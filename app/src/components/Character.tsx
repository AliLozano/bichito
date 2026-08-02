import { getCharacter, type CharacterId, type Pose } from "../lib/characters";

// Self-contained placeholder critter (no binary assets) drawn as a clean, outlined
// little creature so it reads well over ANY wallpaper. Poses nudge legs/arms/body
// so idle/walk/jump/fall/hang look distinct at ~48-56px. Swap this whole component
// for an <img> sprite-sheet in Hito 3 without touching callers (same props).
export function Character({
  id,
  pose = "idle",
  size = 56,
  flip = false,
  frame = 0,
}: {
  id: CharacterId;
  pose?: Pose;
  size?: number;
  flip?: boolean;
  frame?: number; // 0/1 alternating for the walk cycle
}) {
  const c = getCharacter(id);
  const walking = pose === "walk";
  const step = walking ? (frame % 2 === 0 ? -2 : 2) : 0;
  const jump = pose === "jump";
  const armsUp = pose === "hang" || pose === "fall";
  const bob = jump ? -2 : walking && frame % 2 === 0 ? 0.6 : 0;
  const OL = "rgba(0,0,0,0.45)"; // outline so it pops on any background

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      style={{ transform: flip ? "scaleX(-1)" : undefined, display: "block", overflow: "visible" }}
    >
      {/* ears */}
      <path d={`M7 ${8 + bob} L8 ${3 + bob} L11.5 ${7 + bob} Z`} fill={c.body} stroke={OL} strokeWidth="1" strokeLinejoin="round" />
      <path d={`M17 ${8 + bob} L16 ${3 + bob} L12.5 ${7 + bob} Z`} fill={c.body} stroke={OL} strokeWidth="1" strokeLinejoin="round" />

      {/* arms (raised when hanging/falling, otherwise at the sides) */}
      {armsUp ? (
        <>
          <rect x="3.4" y={4.5 + bob} width="3" height="4.2" rx="1.4" fill={c.body} stroke={OL} strokeWidth="0.8" />
          <rect x="17.6" y={4.5 + bob} width="3" height="4.2" rx="1.4" fill={c.body} stroke={OL} strokeWidth="0.8" />
        </>
      ) : (
        <>
          <rect x="3.6" y={11 + bob} width="2.8" height="4.2" rx="1.3" fill={c.body} stroke={OL} strokeWidth="0.8" />
          <rect x="17.6" y={11 + bob} width="2.8" height="4.2" rx="1.3" fill={c.body} stroke={OL} strokeWidth="0.8" />
        </>
      )}

      {/* body */}
      <rect x="5" y={6 + bob} width="14" height="13" rx="6" fill={c.body} stroke={OL} strokeWidth="1.2" />
      {/* belly */}
      <ellipse cx="12" cy={14 + bob} rx="4.2" ry="4.6" fill={c.accent} opacity="0.85" />

      {/* eyes */}
      <circle cx="9.6" cy={11 + bob} r="1.8" fill="#fff" />
      <circle cx="14.4" cy={11 + bob} r="1.8" fill="#fff" />
      <circle cx="9.9" cy={11.3 + bob} r="0.95" fill={c.eye} />
      <circle cx="14.1" cy={11.3 + bob} r="0.95" fill={c.eye} />
      {/* cheeks */}
      <circle cx="7.6" cy={13.4 + bob} r="1" fill={"#f472b6"} opacity="0.5" />
      <circle cx="16.4" cy={13.4 + bob} r="1" fill={"#f472b6"} opacity="0.5" />

      {/* feet */}
      {jump ? (
        <>
          <rect x="8" y="17.5" width="3.2" height="2.6" rx="1.2" fill={c.eye} />
          <rect x="12.8" y="17.5" width="3.2" height="2.6" rx="1.2" fill={c.eye} />
        </>
      ) : (
        <>
          <rect x={8.5 + step} y="18.2" width="3.4" height="3.6" rx="1.6" fill={c.eye} />
          <rect x={12.1 - step} y="18.2" width="3.4" height="3.6" rx="1.6" fill={c.eye} />
        </>
      )}
    </svg>
  );
}
