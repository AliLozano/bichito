import { load, Store } from "@tauri-apps/plugin-store";
import type { CharacterId } from "./characters";

// Persisted user profile. Lives in the app's data dir via tauri-plugin-store.
// `id` is a stable per-install UUID the Rust presence client reads to identify
// this user in the global online list.
export interface Profile {
  id: string;
  name: string;
  character: CharacterId;
  onboarded: boolean;
}

const DEFAULT_PROFILE: Profile = {
  id: "",
  name: "",
  character: "gato",
  onboarded: false,
};

// Shared group "vibe" config. Stored locally; the first person to connect seeds
// the group value and everyone syncs to it (see presence.rs / server).
export interface WorldConfig {
  walkTime: number; // seconds wandering before getting sleepy
  sleepTime: number; // seconds asleep at the edge
  jumpEvery: number; // avg seconds between random leaps (0 = never)
  runSpeed: number; // flee/leap run speed (normalized/s)
}

export const DEFAULT_CONFIG: WorldConfig = {
  walkTime: 25,
  sleepTime: 25,
  jumpEvery: 3600, // ~once an hour by default (configurable 1/min .. 1/hr .. never)
  runSpeed: 0.26,
};

// Cache the PROMISE, not the resolved store, so concurrent callers share one
// load() instead of racing two Store handles against the same file.
let storePromise: Promise<Store> | null = null;

function getStore(): Promise<Store> {
  return (storePromise ??= load("bichito.json", { autoSave: true }));
}

export async function loadProfile(): Promise<Profile> {
  const s = await getStore();
  const saved = await s.get<Profile>("profile");
  const merged = { ...DEFAULT_PROFILE, ...(saved ?? {}) };
  // Ensure a stable id exists and is persisted (Rust reads it from the file).
  if (!merged.id) {
    merged.id = crypto.randomUUID();
    await s.set("profile", merged);
    await s.save();
  }
  return merged;
}

export async function saveProfile(p: Profile): Promise<void> {
  const s = await getStore();
  await s.set("profile", p);
  await s.save();
}

export async function loadConfig(): Promise<WorldConfig> {
  const s = await getStore();
  const saved = await s.get<WorldConfig>("config");
  return { ...DEFAULT_CONFIG, ...(saved ?? {}) };
}

export async function saveConfig(c: WorldConfig): Promise<void> {
  const s = await getStore();
  await s.set("config", c);
  await s.save();
}
