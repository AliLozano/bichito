import { Character } from "../components/Character";
import { PetLabel } from "./PetLabel";
import { GripMeter } from "./GripMeter";
import type { Pet, Sim } from "./sim";

// Thin renderer: draws one pet from the Sim, converting normalized (0..1) coords
// to pixels at render time (x * innerWidth). No physics here — the Sim owns state.
const SIZE = 56;

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
        <Character id={pet.character} pose={pose} size={SIZE} flip={pet.flip} frame={pet.frame} />
      </div>
    </>
  );
}
