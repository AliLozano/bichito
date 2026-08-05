import { load, Store } from "@tauri-apps/plugin-store";
import { type WorldConfig, DEFAULT_CONFIG } from "./world-config";

// Re-exported so existing imports (`from "../lib/store"`) keep working; the actual
// definitions live in world-config.ts (Tauri-free, importable headless by the bot).
export { type WorldConfig, DEFAULT_CONFIG };

// Persisted user profile. Lives in the app's data dir via tauri-plugin-store.
// `id` is a stable per-install UUID the Rust presence client reads to identify
// this user in the global online list.
export interface Profile {
  id: string;
  name: string;
  character: string; // a built-in CharacterId or a custom avatar folder name
  onboarded: boolean;
}

const DEFAULT_PROFILE: Profile = {
  id: "",
  name: "",
  character: "gato",
  onboarded: false,
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

// Local (per-device) settings — NOT shared with the group, unlike WorldConfig.
// This is the "Local" tab of the settings window.
export interface LocalSettings {
  showStats: boolean; // overlay HUD with FPS + latency (RTT) to the server
  volume: number; // 0..1 master volume for minigame SFX
  autoUpdate: boolean; // check periodically and install new versions in the background
  hideGhostCursors: boolean; // don't render friends' ghost cursors on MY screen
}

export const DEFAULT_LOCAL: LocalSettings = {
  showStats: false,
  volume: 0.6,
  autoUpdate: true, // on by default — the pet quietly keeps itself up to date
  hideGhostCursors: false,
};

export async function loadLocal(): Promise<LocalSettings> {
  const s = await getStore();
  const saved = await s.get<LocalSettings>("local");
  return { ...DEFAULT_LOCAL, ...(saved ?? {}) };
}

export async function saveLocal(v: LocalSettings): Promise<void> {
  const s = await getStore();
  await s.set("local", v);
  await s.save();
}
