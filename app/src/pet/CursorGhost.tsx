import { GhostArrow } from "./GhostArrow";
import type { RemoteCursor } from "./sim";

// A friend's "ghost" cursor — shown only while they're interacting (grabbing a
// pet, having a pet on their cursor, or charging a grip). Normalized -> pixels.
export function CursorGhost({ cursor }: { cursor: RemoteCursor }) {
  if (!cursor.active) return null;
  const x = cursor.x * window.innerWidth;
  const y = cursor.y * window.innerHeight;
  return (
    <>
      <GhostArrow x={x} y={y} glow />
      {cursor.name && (
        <div
          style={{
            position: "fixed",
            left: x + 16,
            top: y + 10,
            fontSize: 10,
            fontWeight: 700,
            color: "#fff",
            background: "rgba(100,116,139,0.85)",
            padding: "1px 5px",
            borderRadius: 7,
            pointerEvents: "none",
            whiteSpace: "nowrap",
          }}
        >
          {cursor.name}
        </div>
      )}
    </>
  );
}
