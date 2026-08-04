// Tiny, click-through overlay HUD: local render FPS + round-trip latency (RTT) to
// the presence server. Toggled from the "Local" settings tab. Purely local/diagnostic
// (it reflects THIS device), so it lives outside the shared world config.
function color(ok: boolean, warn: boolean) {
  return ok ? "#4ade80" : warn ? "#fbbf24" : "#f87171";
}

export function StatsHud({ fps, rtt }: { fps: number; rtt: number }) {
  const f = Math.round(fps);
  const r = rtt < 0 ? null : Math.round(rtt);
  return (
    <div
      style={{
        position: "fixed",
        top: 8,
        left: 8,
        display: "flex",
        gap: 10,
        padding: "4px 9px",
        borderRadius: 8,
        background: "rgba(0,0,0,0.55)",
        font: "600 12px ui-monospace, SFMono-Regular, Menlo, monospace",
        color: "#e5e7eb",
        pointerEvents: "none",
        userSelect: "none",
        lineHeight: 1.4,
      }}
    >
      <span style={{ color: color(f >= 50, f >= 30) }}>{f} fps</span>
      <span style={{ color: r == null ? "#9ca3af" : color(r <= 80, r <= 160) }}>
        {r == null ? "— ms" : `${r} ms`}
      </span>
    </div>
  );
}
