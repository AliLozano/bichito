// A translucent "ghost" of a friend's mouse cursor. Rendered on BOTH sides during
// a grab so each person can see the other's cursor:
//  • grabber sees the target's cursor (with their own bichito clinging to it)
//  • target sees the grabber's cursor approaching (which is WHY the grip tightens)
export function GhostArrow({
  x,
  y,
  glow = false,
  opacity = 1,
}: {
  x: number;
  y: number;
  glow?: boolean;
  opacity?: number;
}) {
  return (
    <div
      style={{
        position: "fixed",
        left: x,
        top: y,
        pointerEvents: "none",
        transform: "translate(-2px,-2px)",
        transition: "filter 0.1s",
      }}
    >
      <svg
        width="24"
        height="24"
        viewBox="0 0 22 22"
        style={{ opacity: (glow ? 0.85 : 0.55) * opacity, filter: glow ? "drop-shadow(0 0 7px #f472b6)" : "none" }}
      >
        <path
          d="M3 2 L3 17 L7 13 L10 20 L13 19 L10 12 L16 12 Z"
          fill="#c4b5fd"
          stroke="#7c3aed"
          strokeWidth="1"
        />
      </svg>
    </div>
  );
}
