// Shared group "vibe" config — kept in its OWN module (no Tauri imports) so the
// headless bot can import the Sim without pulling in @tauri-apps/plugin-store.
// `store.ts` re-exports these for the app.

export interface WorldConfig {
  walkTime: number; // seconds wandering before getting sleepy
  sleepTime: number; // seconds asleep at the edge
  jumpEvery: number; // avg seconds between random leaps (0 = never)
  runSpeed: number; // flee/leap run speed (normalized/s)
  allowLeap: boolean; // false = never leap onto cursors; released pets just fall (less intrusive)
}

export const DEFAULT_CONFIG: WorldConfig = {
  walkTime: 25,
  sleepTime: 25,
  jumpEvery: 3600, // ~once an hour by default (configurable 1/min .. 1/hr .. never)
  runSpeed: 0.26,
  allowLeap: true,
};
