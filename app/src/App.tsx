import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { emitTo } from "@tauri-apps/api/event";
import { isEnabled, enable, disable } from "@tauri-apps/plugin-autostart";
import { Onboarding } from "./windows/Onboarding";
import { ConfigPanel } from "./windows/ConfigPanel";
import { Updater } from "./windows/Updater";
import { Character } from "./components/Character";
import {
  loadProfile,
  saveProfile,
  loadLocal,
  saveLocal,
  DEFAULT_LOCAL,
  type Profile,
  type LocalSettings,
} from "./lib/store";
import { getCharacter, type CharacterId } from "./lib/characters";
import { type Avatar } from "./lib/avatars";

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

// The "Local" (per-device) settings tab. These are NOT shared with the group: launch
// at login, the FPS/latency HUD, and the game volume. Changes save locally and push
// the whole LocalSettings object to the overlay live (which applies HUD + volume).
function LocalTab() {
  const [local, setLocal] = useState<LocalSettings>(DEFAULT_LOCAL);
  useEffect(() => {
    loadLocal().then(setLocal).catch(() => {});
  }, []);
  const update = async (patch: Partial<LocalSettings>) => {
    const next = { ...local, ...patch };
    setLocal(next);
    await saveLocal(next).catch(() => {});
    await emitTo("overlay", "local-settings", next).catch(() => {});
  };
  return (
    <div className="flex flex-col gap-4">
      <div className="text-sm text-white/70">Ajustes solo de esta computadora</div>
      <AutostartToggle />
      <button
        onClick={() => update({ autoUpdate: !local.autoUpdate })}
        className="flex items-center justify-between gap-3 w-full text-sm py-1"
      >
        <span className="flex flex-col items-start">
          <span>Actualizaciones automáticas</span>
          <span className="text-xs text-white/40 text-left">
            Instala nuevas versiones en segundo plano cuando estás inactivo.
          </span>
        </span>
        <span
          className={`shrink-0 w-11 h-6 rounded-full relative transition ${
            local.autoUpdate ? "bg-bichito-accent" : "bg-white/15"
          }`}
        >
          <span
            className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all ${
              local.autoUpdate ? "left-[22px]" : "left-0.5"
            }`}
          />
        </span>
      </button>
      <button
        onClick={() => update({ showStats: !local.showStats })}
        className="flex items-center justify-between gap-3 w-full text-sm py-1"
      >
        <span className="flex flex-col items-start">
          <span>Mostrar FPS y latencia</span>
          <span className="text-xs text-white/40 text-left">
            Un recuadro con los cuadros por segundo y el ping al servidor.
          </span>
        </span>
        <span
          className={`shrink-0 w-11 h-6 rounded-full relative transition ${
            local.showStats ? "bg-bichito-accent" : "bg-white/15"
          }`}
        >
          <span
            className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all ${
              local.showStats ? "left-[22px]" : "left-0.5"
            }`}
          />
        </span>
      </button>
      <label className="flex flex-col gap-1">
        <div className="flex justify-between text-sm">
          <span>Volumen del juego</span>
          <span className="text-white/50">{Math.round(local.volume * 100)}%</span>
        </div>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={local.volume}
          onChange={(e) => update({ volume: parseFloat(e.target.value) })}
          className="w-full accent-bichito-accent"
        />
        <div className="text-xs text-white/40">Sonidos de espadazos, golpes y choques.</div>
      </label>
    </div>
  );
}

export function App() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [avatars, setAvatars] = useState<Avatar[]>([]);
  const [tab, setTab] = useState<"sala" | "local">("sala");

  useEffect(() => {
    loadProfile().then(setProfile);
    // custom skins authored in ~/.bichito/avatars/ (shown alongside the defaults)
    const refreshAvatars = () =>
      invoke<Avatar[]>("list_avatars").then(setAvatars).catch(() => {});
    refreshAvatars();
    // re-scan whenever this window regains focus — so a pet you just created in the
    // folder shows up when you switch back, no reopen needed.
    const unlisten = getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      if (focused) refreshAvatars();
    });
    return () => {
      unlisten.then((f) => f()).catch(() => {});
    };
  }, []);

  if (!profile) return <div className="min-h-screen" />;

  const persist = async (name: string, character: string, onboarded: boolean) => {
    const next: Profile = { id: profile.id, name, character, onboarded };
    await saveProfile(next);
    setProfile(next);
    // tell the overlay window to pick up the (possibly new) character live
    await emitTo("overlay", "profile-changed", next).catch(() => {});
    // re-announce my character (+ its custom avatar) to peers without reconnecting
    await invoke("set_character", { character }).catch(() => {});
    return next;
  };

  if (!profile.onboarded) {
    return (
      <Onboarding
        initialName={profile.name}
        initialCharacter={profile.character as CharacterId}
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
  const currentAvatar = avatars.find((a) => a.name === profile.character);
  const c = getCharacter(profile.character);
  const displayCharacter = currentAvatar ? currentAvatar.name : c.name;
  return (
    <div className="min-h-screen p-6 flex flex-col gap-6">
      <div className="flex items-center gap-4">
        <div className="p-2 rounded-xl bg-black/30">
          <Character id={profile.character} avatar={currentAvatar} pose="idle" size={48} />
        </div>
        <div>
          <div className="text-lg font-bold">{profile.name || "Sin nombre"}</div>
          <div className="text-white/50 text-sm">Personaje: {displayCharacter}</div>
        </div>
      </div>

      <div>
        <div className="text-sm text-white/70 mb-3">Cambiar personaje</div>
        <div className="grid grid-cols-4 gap-3">
          {(["gato", "rana", "fantasma", "robotito"] as const).map((id) => (
            <button
              key={id}
              onClick={() => persist(profile.name, id, true)}
              className={`flex flex-col items-center gap-1 py-3 rounded-xl border transition ${
                profile.character === id
                  ? "border-bichito-accent bg-bichito-accent/10"
                  : "border-white/10 hover:border-white/25"
              }`}
            >
              <Character id={id} pose="idle" size={36} />
            </button>
          ))}
          {avatars.map((a) => (
            <button
              key={"custom:" + a.name}
              title={a.name}
              onClick={() => persist(profile.name, a.name, true)}
              className={`flex flex-col items-center gap-1 py-3 rounded-xl border transition ${
                profile.character === a.name
                  ? "border-bichito-accent bg-bichito-accent/10"
                  : "border-white/10 hover:border-white/25"
              }`}
            >
              <Character id={a.name} avatar={a} pose="idle" size={36} />
            </button>
          ))}
        </div>
        <button
          onClick={() => invoke("open_avatars_dir").catch(() => {})}
          className="mt-3 w-full py-2 rounded-xl border border-white/10 hover:border-white/25 text-sm text-white/80 transition"
        >
          📁 Abrir carpeta de avatares
        </button>
        <div className="text-xs text-white/40 mt-2">
          Crea los tuyos poniendo SVGs en <span className="text-white/60">~/.bichito/avatars/</span>.
          Mira el <span className="text-white/60">CLAUDE.md</span> y el ejemplo que hay ahí.
        </div>
      </div>

      {/* update banner sits above the tabs so it's never hidden behind one */}
      <Updater />

      {/* two scopes: "Sala" = shared with the group, "Local" = only this device */}
      <div className="border-t border-white/10 pt-4">
        <div className="flex gap-1 p-1 rounded-xl bg-black/25 mb-4">
          {([
            ["sala", "Sala (compartido)"],
            ["local", "Este dispositivo"],
          ] as const).map(([id, label]) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={`flex-1 py-1.5 rounded-lg text-sm transition ${
                tab === id ? "bg-bichito-accent/25 text-white" : "text-white/55 hover:text-white/80"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {tab === "sala" ? <ConfigPanel /> : <LocalTab />}
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
