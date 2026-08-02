import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { emitTo } from "@tauri-apps/api/event";
import { isEnabled, enable, disable } from "@tauri-apps/plugin-autostart";
import { Onboarding } from "./windows/Onboarding";
import { ConfigPanel } from "./windows/ConfigPanel";
import { Character } from "./components/Character";
import { loadProfile, saveProfile, type Profile } from "./lib/store";
import { getCharacter, type CharacterId } from "./lib/characters";

// Local (per-device) toggle: launch bichito at login. Enabled by default after
// onboarding; this lets the user turn it off. Works on macOS + Windows.
function AutostartToggle() {
  const [on, setOn] = useState(false);
  useEffect(() => {
    isEnabled().then(setOn).catch(() => {});
  }, []);
  const toggle = async () => {
    try {
      if (on) await disable();
      else await enable();
      setOn(!on);
    } catch {
      /* ignore */
    }
  };
  return (
    <button
      onClick={toggle}
      className="flex items-center justify-between gap-3 w-full text-sm py-1"
    >
      <span>Abrir al iniciar la computadora</span>
      <span
        className={`w-11 h-6 rounded-full relative transition ${
          on ? "bg-bichito-accent" : "bg-white/15"
        }`}
      >
        <span
          className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all ${
            on ? "left-[22px]" : "left-0.5"
          }`}
        />
      </span>
    </button>
  );
}

export function App() {
  const [profile, setProfile] = useState<Profile | null>(null);

  useEffect(() => {
    loadProfile().then(setProfile);
  }, []);

  if (!profile) return <div className="min-h-screen" />;

  const persist = async (name: string, character: CharacterId, onboarded: boolean) => {
    const next: Profile = { id: profile.id, name, character, onboarded };
    await saveProfile(next);
    setProfile(next);
    // tell the overlay window to pick up the (possibly new) character live
    await emitTo("overlay", "profile-changed", next).catch(() => {});
    return next;
  };

  if (!profile.onboarded) {
    return (
      <Onboarding
        initialName={profile.name}
        initialCharacter={profile.character}
        onDone={async (name, character) => {
          await persist(name, character, true);
          // hand off to the tray: show overlay, hide this window
          await invoke("finish_onboarding").catch(() => {});
          await getCurrentWindow().hide().catch(() => {});
        }}
      />
    );
  }

  // Settings / status panel (opened from the tray "Preferencias").
  const c = getCharacter(profile.character);
  return (
    <div className="min-h-screen p-6 flex flex-col gap-6">
      <div className="flex items-center gap-4">
        <div className="p-2 rounded-xl bg-black/30">
          <Character id={profile.character} pose="idle" size={48} />
        </div>
        <div>
          <div className="text-lg font-bold">{profile.name || "Sin nombre"}</div>
          <div className="text-white/50 text-sm">Personaje: {c.name}</div>
        </div>
      </div>

      <div>
        <div className="text-sm text-white/70 mb-3">Cambiar personaje</div>
        <div className="grid grid-cols-4 gap-3">
          {["gato", "rana", "fantasma", "robotito"].map((id) => (
            <button
              key={id}
              onClick={() => persist(profile.name, id as CharacterId, true)}
              className={`flex flex-col items-center gap-1 py-3 rounded-xl border transition ${
                profile.character === id
                  ? "border-bichito-accent bg-bichito-accent/10"
                  : "border-white/10 hover:border-white/25"
              }`}
            >
              <Character id={id as CharacterId} pose="idle" size={36} />
            </button>
          ))}
        </div>
      </div>

      <div className="border-t border-white/10 pt-4">
        <ConfigPanel />
      </div>

      <div className="border-t border-white/10 pt-4">
        <AutostartToggle />
      </div>

      <button
        onClick={() => invoke("hide_main")}
        className="mt-auto py-2.5 rounded-xl bg-white/10 hover:bg-white/15 text-sm transition"
      >
        Cerrar (sigo viviendo en la barra)
      </button>
    </div>
  );
}
