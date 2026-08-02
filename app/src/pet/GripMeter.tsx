// Tiny grip strength bar shown above a hanging pet: how tightly it's holding on.
// Red = about to slip, green = firmly gripped.
export function GripMeter({ level, x, y }: { level: number; x: number; y: number }) {
  const pct = Math.max(0, Math.min(1, level));
  const hue = pct * 120; // 0 = red, 120 = green
  return (
    <div
      style={{
        position: "fixed",
        left: x,
        top: y,
        width: 64,
        transform: "translateX(-50%)",
        pointerEvents: "none",
      }}
    >
      <div
        style={{
          height: 9,
          borderRadius: 5,
          background: "rgba(0,0,0,0.55)",
          border: "1px solid rgba(255,255,255,0.4)",
          overflow: "hidden",
          boxShadow: "0 1px 3px rgba(0,0,0,0.4)",
        }}
      >
        <div
          style={{
            height: "100%",
            width: `${pct * 100}%`,
            background: `hsl(${hue} 90% 55%)`,
            transition: "width 0.08s linear",
          }}
        />
      </div>
    </div>
  );
}
