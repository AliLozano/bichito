// Character catalog. For Hito 1 these are self-contained SVG-drawn critters so the
// app runs with zero binary assets. In Hito 3 we swap `sprite` in for a real
// sprite-sheet (see assets/characters/README.md for the licensing plan).

export type CharacterId = "gato" | "rana" | "fantasma" | "robotito";

export type Pose = "idle" | "walk" | "jump" | "fall" | "hang" | "sleep" | "crouch";

export interface Character {
  id: CharacterId;
  name: string;
  /** Base palette used by the placeholder SVG renderer. */
  body: string;
  accent: string;
  eye: string;
}

export const CHARACTERS: Character[] = [
  { id: "gato", name: "Gato", body: "#f59e0b", accent: "#fbbf24", eye: "#1f2937" },
  { id: "rana", name: "Rana", body: "#22c55e", accent: "#4ade80", eye: "#052e16" },
  { id: "fantasma", name: "Fantasma", body: "#e2e8f0", accent: "#c4b5fd", eye: "#1e293b" },
  { id: "robotito", name: "Robotito", body: "#60a5fa", accent: "#f472b6", eye: "#0f172a" },
];

export function getCharacter(id: CharacterId | string | undefined): Character {
  return CHARACTERS.find((c) => c.id === id) ?? CHARACTERS[0];
}
