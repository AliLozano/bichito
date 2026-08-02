import { Character } from "../components/Character";
import { PetLabel } from "./PetLabel";
import { GripMeter } from "./GripMeter";
import { SPRITE_PX, COLLIDE_R, type Pet, type Sim } from "./sim";

// Thin renderer: draws one pet from the Sim, converting normalized (0..1) coords
// to pixels at render time (x * innerWidth). No physics here — the Sim owns state.
const SIZE = SPRITE_PX;
const DEBUG_HIT = false; // draw the click hit-zones (grab/capture)
const DEBUG_COLLISION = false; // draw the pet↔pet collision zone
const GRAB_R = SPRITE_PX * 0.64; // must match petAt() default radius
const CAP_R = SPRITE_PX * 0.95; // must match overlay-main capture radius

function HitDebug({ px, py }: { px: number; py: number }) {
  const ring = (r: number, color: string, dash: boolean) => ({
    position: "fixed" as const,
    left: px - r,
    top: py - r,
    width: r * 2,
    height: r * 2,
    borderRadius: "50%",
    border: `1.5px ${dash ? "dashed" : "solid"} ${color}`,
    pointerEvents: "none" as const,
    boxSizing: "border-box" as const,
  });
  return (
    <>
      {DEBUG_HIT && <div style={ring(CAP_R, "rgba(250,204,21,0.7)", true)} />}
      {DEBUG_HIT && <div style={ring(GRAB_R, "rgba(34,197,94,0.9)", false)} />}
      {/* collision zone: a real px circle (COLLIDE_R). Two pets collide when these
          circles touch (centers within 2*COLLIDE_R). */}
      {DEBUG_COLLISION && <div style={ring(COLLIDE_R, "rgba(56,189,248,0.9)", false)} />}
      <div
        style={{
          position: "fixed",
          left: px - 2,
          top: py - 2,
          width: 4,
          height: 4,
          borderRadius: "50%",
          background: "red",
          pointerEvents: "none",
        }}
      />
    </>
  );
}

export function PetView({ pet, sim, mine }: { pet: Pet; sim: Sim; mine: boolean }) {
  if (pet.state === "gone") return null;
  const px = pet.x * window.innerWidth;
  const py = pet.y * window.innerHeight;
  const pose = sim.pose(pet);
  // thrown pets tumble; held/oncursor keep their fall angle via a gentle sway
  const rot =
    pet.state === "thrown"
      ? pet.spin
      : pet.state === "dizzy"
      ? Math.sin(pet.t * 16) * 14 // dazed wobble — "grab me!"
      : pet.state === "held" || pet.state === "oncursor"
      ? Math.sin(pet.t * 8) * 6
      : 0;
  const onCursor = pet.state === "oncursor";

  return (
    <>
      {(DEBUG_HIT || DEBUG_COLLISION) && <HitDebug px={px} py={py} />}
      {onCursor && <GripMeter level={pet.grip} x={px} y={py + SIZE * 0.6} />}
      <div
        style={{
          position: "fixed",
          left: px - SIZE / 2,
          top: py - SIZE / 2,
          width: SIZE,
          height: SIZE,
          pointerEvents: "none",
          transform: `rotate(${rot}deg)`,
          filter: "drop-shadow(0 2px 2px rgba(0,0,0,0.35))",
        }}
      >
        <PetLabel
          name={pet.name}
          color={mine ? "rgba(124,58,237,0.92)" : "rgba(244,114,182,0.9)"}
        />
        {pet.state === "dizzy" && (
          <div
            style={{
              position: "absolute",
              top: -6,
              left: "50%",
              transform: `translateX(-50%) rotate(${-rot}deg)`,
              fontSize: 16,
              pointerEvents: "none",
            }}
          >
            💫
          </div>
        )}
        {pet.state === "sleeping" && (
          <div
            style={{
              position: "absolute",
              top: -10,
              left: "62%",
              fontSize: 13,
              opacity: 0.85,
              pointerEvents: "none",
            }}
          >
            💤
          </div>
        )}
        <Character id={pet.character} pose={pose} size={SIZE} flip={pet.flip} frame={pet.frame} />
      </div>
    </>
  );
}
