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
  activity,
  combat = false,
}: {
  id: CharacterId;
  pose?: Pose;
  size?: number;
  flip?: boolean;
  frame?: number; // 0/1 alternating for the walk cycle
  activity?: string; // idle activity prop drawn into the sprite: coding | coffee | music | thinking
  combat?: boolean; // minigame attack mode: draw the nail (little sword) held out front
}) {
  const c = getCharacter(id);
  const walking = pose === "walk";
  const step = walking ? (frame % 2 === 0 ? -2 : 2) : 0;
  const jump = pose === "jump";
  const crouch = pose === "crouch";
  const armsUp = pose === "hang" || pose === "fall";
  const bob = crouch ? 3.5 : jump ? -2 : walking && frame % 2 === 0 ? 0.6 : 0;
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

      {/* eyes — closed (sleeping) or open */}
      {pose === "sleep" ? (
        <>
          <path d={`M8.2 ${11 + bob} q1.4 1.4 2.8 0`} fill="none" stroke={c.eye} strokeWidth="0.9" strokeLinecap="round" />
          <path d={`M13 ${11 + bob} q1.4 1.4 2.8 0`} fill="none" stroke={c.eye} strokeWidth="0.9" strokeLinecap="round" />
        </>
      ) : (
        <>
          <circle cx="9.6" cy={11 + bob} r="1.8" fill="#fff" />
          <circle cx="14.4" cy={11 + bob} r="1.8" fill="#fff" />
          <circle cx="9.9" cy={11.3 + bob} r="0.95" fill={c.eye} />
          <circle cx="14.1" cy={11.3 + bob} r="0.95" fill={c.eye} />
        </>
      )}
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

      {/* --- idle-activity props, drawn into the sprite (not floating emoji) --- */}
      {activity === "music" && (
        <>
          {/* headphone band over the head */}
          <path d="M4.6 8 Q12 -0.4 19.4 8" fill="none" stroke={OL} strokeWidth="1.4" strokeLinecap="round" />
          <path d="M4.6 8 Q12 -0.4 19.4 8" fill="none" stroke="#334155" strokeWidth="0.9" strokeLinecap="round" />
          {/* earcups */}
          <rect x="3.2" y="8" width="2.7" height="3.8" rx="1.2" fill="#334155" stroke={OL} strokeWidth="0.5" />
          <rect x="18.1" y="8" width="2.7" height="3.8" rx="1.2" fill="#334155" stroke={OL} strokeWidth="0.5" />
          {/* music notes */}
          <circle cx="21.4" cy="6.4" r="0.7" fill="#a78bfa" />
          <rect x="21.9" y="3.6" width="0.5" height="2.9" fill="#a78bfa" />
        </>
      )}
      {activity === "coffee" && (
        <>
          {/* steam */}
          <path d="M12 8 q0.9 0.8 0 1.7 q-0.9 0.9 0 1.8" fill="none" stroke="#fff" strokeWidth="0.5" opacity="0.55" strokeLinecap="round" />
          <path d="M14 8.2 q0.9 0.8 0 1.7 q-0.9 0.9 0 1.8" fill="none" stroke="#fff" strokeWidth="0.5" opacity="0.4" strokeLinecap="round" />
          {/* cup */}
          <path d="M10.6 11.4 h5 v2.6 a2.5 2.5 0 0 1 -5 0 z" fill="#fdf2f8" stroke={OL} strokeWidth="0.7" strokeLinejoin="round" />
          <ellipse cx="13.1" cy="11.4" rx="2.5" ry="0.8" fill="#7c3f00" stroke={OL} strokeWidth="0.5" />
          {/* handle */}
          <path d="M15.6 12 a1.4 1.4 0 0 1 0 2.4" fill="none" stroke={OL} strokeWidth="0.8" />
        </>
      )}
      {activity === "coding" && (
        <>
          {/* laptop in front of the pet */}
          <rect x="7.3" y="14" width="9.4" height="6.3" rx="0.7" fill="#1e293b" stroke={OL} strokeWidth="0.7" />
          <rect x="8.2" y="14.9" width="7.6" height="4.5" rx="0.3" fill="#0b1220" />
          {/* code lines glowing on the screen */}
          <rect x="8.9" y="15.7" width="4.2" height="0.55" rx="0.27" fill="#4ade80" opacity="0.95" />
          <rect x="8.9" y="17" width="5.8" height="0.55" rx="0.27" fill="#60a5fa" opacity="0.85" />
          <rect x="8.9" y="18.3" width="3.2" height="0.55" rx="0.27" fill="#fbbf24" opacity="0.85" />
          {/* keyboard base */}
          <path d="M6.2 20.1 h11.6 l1.1 1.6 h-13.8 z" fill="#334155" stroke={OL} strokeWidth="0.6" strokeLinejoin="round" />
        </>
      )}
      {/* --- attack mode: the nail (a little sword) held out in the facing direction --- */}
      {combat && (
        <>
          <rect x="18.4" y={12.2 + bob} width="1.6" height="3.6" rx="0.5" fill="#7c5b34" stroke={OL} strokeWidth="0.4" />
          <rect x="17.6" y={11.9 + bob} width="3.2" height="1" rx="0.4" fill="#9ca3af" stroke={OL} strokeWidth="0.4" />
          <path
            d={`M18.6 ${11.7 + bob} L24.8 ${5.9 + bob} L25.6 ${6.9 + bob} L19.4 ${12.5 + bob} Z`}
            fill="#eef2f7"
            stroke={OL}
            strokeWidth="0.4"
            strokeLinejoin="round"
          />
          <circle cx="24.9" cy={6.1 + bob} r="0.5" fill="#ffffff" opacity="0.9" />
        </>
      )}
      {activity === "thinking" && (
        <>
          <circle cx="18.2" cy="6.8" r="0.7" fill="#fff" stroke={OL} strokeWidth="0.4" />
          <circle cx="19.9" cy="5" r="1" fill="#fff" stroke={OL} strokeWidth="0.4" />
          <ellipse cx="22.2" cy="2.6" rx="2.5" ry="1.8" fill="#fff" stroke={OL} strokeWidth="0.5" />
          <circle cx="21.1" cy="2.6" r="0.35" fill={OL} />
          <circle cx="22.3" cy="2.6" r="0.35" fill={OL} />
          <circle cx="23.5" cy="2.6" r="0.35" fill={OL} />
        </>
      )}
    </svg>
  );
}
