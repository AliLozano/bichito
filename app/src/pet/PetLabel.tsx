// Small name tag shown above a pet. Positioned relative to the pet's container
// (which must be position:fixed/relative).
export function PetLabel({ name, color = "rgba(124,58,237,0.92)" }: { name: string; color?: string }) {
  if (!name) return null;
  return (
    <div
      style={{
        position: "absolute",
        top: -16,
        left: "50%",
        transform: "translateX(-50%)",
        whiteSpace: "nowrap",
        fontSize: 11,
        fontWeight: 700,
        color: "#fff",
        background: color,
        padding: "1px 6px",
        borderRadius: 8,
        pointerEvents: "none",
      }}
    >
      {name}
    </div>
  );
}
