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
