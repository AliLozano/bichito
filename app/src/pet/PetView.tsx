import { Character } from "../components/Character";
import { PetLabel } from "./PetLabel";
import { GripMeter } from "./GripMeter";
import { SPRITE_PX, COLLIDE_R, type Pet, type Sim } from "./sim";

// Thin renderer: draws one pet from the Sim, converting normalized (0..1) coords
// to pixels at render time (x * innerWidth). No physics here — the Sim owns state.
const SIZE = SPRITE_PX;
// idle activities drawn INTO the sprite (see Character.tsx); sleeping keeps a 💤 puff
const SVG_ACTIVITIES = ["coding", "coffee", "music", "thinking"];
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

export function PetView({
  pet,
  sim,
  mine,
  flash = false,
  charge = 0,
  duel = false,
}: {
  pet: Pet;
  sim: Sim;
  mine: boolean;
  flash?: boolean; // just hit in the minigame -> hit flash (game-owned, passed in)
  charge?: number; // 0..1 Nail-Art charge on MY pet -> glow (game-owned)
  duel?: boolean; // ≥2 pets in a match -> show health bars (hidden when playing solo)
}) {
  if (pet.state === "gone") return null;
  const px = pet.x * window.innerWidth;
  const py = pet.y * window.innerHeight;
  const pose = sim.pose(pet);
  // "dazed" = the DIZZY state (knocked out of health / thrown), NOT every hit. It rocks
  // the sprite ±10° so it clearly reads as stunned. A per-hit flash is handled separately
  // (💥 + brightness). Wall clock (not pet.t, which resets each frame) so it animates.
  const dazed = pet.state === "dizzy";
  // thrown pets tumble; dazed rocks ±45°; held/oncursor keep their fall angle via a sway
  const rot =
    pet.state === "thrown"
      ? pet.spin
      : dazed
      ? Math.sin(performance.now() * 0.02) * 10
      : pet.state === "held" || pet.state === "oncursor"
      ? Math.sin(pet.t * 8) * 6
      : 0;
  const onCursor = pet.state === "oncursor";
  const inMatch = pet.state === "play";
  const hitFlash = flash; // just shot in the minigame (computed by the game engine)
  // the green bar doubles as grip (while clinging to a cursor) and health. Health shows
  // during a real duel (≥2 fighters), OR whenever a pet is hurt (health < full) so you
  // SEE damage when pestering a passive pet — it hides again once it heals/respawns.
  const showBar = onCursor || (inMatch && duel) || pet.health < 0.999;
  const barLevel = onCursor ? pet.grip : pet.health;

  return (
    <>
      {(DEBUG_HIT || DEBUG_COLLISION) && <HitDebug px={px} py={py} />}
      {showBar && <GripMeter level={barLevel} x={px} y={py + SIZE * 0.6} />}
      <div
        style={{
          position: "fixed",
          left: px - SIZE / 2,
          top: py - SIZE / 2,
          width: SIZE,
          height: SIZE,
          pointerEvents: "none",
          transform: `rotate(${rot}deg)`,
          filter: hitFlash
            ? "drop-shadow(0 0 6px rgba(248,113,113,0.95)) brightness(1.7)"
            : "drop-shadow(0 2px 2px rgba(0,0,0,0.35))",
        }}
      >
        {hitFlash && (
          <div
            style={{
              position: "absolute",
              top: -8,
              left: "50%",
              transform: `translateX(-50%) rotate(${-rot}deg)`,
              fontSize: 18,
              pointerEvents: "none",
            }}
          >
            💥
          </div>
        )}
        {charge > 0 && (
          <div
            style={{
              position: "absolute",
              inset: -SIZE * 0.15,
              borderRadius: "50%",
              boxShadow: `0 0 ${8 + charge * 18}px ${2 + charge * 6}px rgba(186,230,253,${
                0.2 + charge * 0.5
              })`,
              background:
                charge >= 1 ? "radial-gradient(circle, rgba(255,255,255,0.28), transparent 70%)" : undefined,
              pointerEvents: "none",
            }}
          />
        )}
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
              fontSize: 14,
              opacity: 0.9,
              pointerEvents: "none",
            }}
          >
            💤
          </div>
        )}
        <Character
          id={pet.character}
          pose={pose}
          size={SIZE}
          flip={pet.flip}
          frame={pet.frame}
          combat={inMatch}
          activity={SVG_ACTIVITIES.includes(pet.state) ? pet.state : undefined}
        />
      </div>
    </>
  );
}
