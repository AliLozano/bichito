import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { loadConfig, saveConfig, DEFAULT_CONFIG, type WorldConfig } from "../lib/store";

// Shared group "vibe" settings. Edits are saved locally and broadcast to the
// whole friend group (the first person to connect seeds it; anyone can update).
const dur = (v: number) => {
  const s = Math.round(v);
  if (s < 60) return `${s} s`;
  const m = s / 60;
  return Number.isInteger(m) ? `${m} min` : `${m.toFixed(1)} min`;
};

function Row({
  label,
  hint,
  min,
  max,
  step,
  value,
  fmt,
  onChange,
}: {
  label: string;
  hint: string;
  min: number;
  max: number;
  step: number;
  value: number;
  fmt: (v: number) => string;
  onChange: (v: number) => void;
}) {
  return (
    <label className="flex flex-col gap-1">
      <div className="flex justify-between text-sm">
        <span>{label}</span>
        <span className="text-white/50">{fmt(value)}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="w-full accent-bichito-accent"
      />
      <div className="text-xs text-white/40">{hint}</div>
    </label>
  );
}

export function ConfigPanel() {
  const [cfg, setCfg] = useState<WorldConfig>(DEFAULT_CONFIG);
  const [status, setStatus] = useState<"saved" | "saving">("saved");
  const latest = useRef<WorldConfig>(DEFAULT_CONFIG); // newest value for the debounced save
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef(false); // a local edit is in flight (ignore our own echo)

  useEffect(() => {
    invoke<WorldConfig | null>("get_config")
      .then((c) => {
        const v = c ?? DEFAULT_CONFIG;
        setCfg(v);
        latest.current = v;
      })
      .catch(() =>
        loadConfig().then((v) => {
          setCfg(v);
          latest.current = v;
        })
      );
    // reflect changes made by a friend. Ignore echoes while a local edit is in flight
    // (net_config broadcasts to EVERYONE incl. us; applying our own echo mid-drag would
    // revert the in-progress slider and can lose the newest change).
    const un = listen<WorldConfig>("config", (e) => {
      if (pending.current) return;
      setCfg(e.payload);
      latest.current = e.payload;
      setStatus("saved");
    });
    return () => {
      un.then((f) => f());
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  // any edit auto-saves + syncs to the group after a short debounce (no button).
  const set = (patch: Partial<WorldConfig>) => {
    setCfg((c) => {
      const next = { ...c, ...patch };
      latest.current = next;
      return next;
    });
    setStatus("saving");
    pending.current = true;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      await saveConfig(latest.current);
      await invoke("net_config", { config: latest.current }).catch(() => {});
      pending.current = false;
      setStatus("saved");
    }, 500);
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="text-sm text-white/70">Comportamiento (compartido con tus amigos)</div>
      <Row
        label="Caminan"
        hint="Cuánto pasean antes de irse a dormir a un lado."
        min={5}
        max={600}
        step={5}
        value={cfg.walkTime}
        fmt={dur}
        onChange={(v) => set({ walkTime: v })}
      />
      <Row
        label="Duermen"
        hint="Cuánto se quedan dormidas en el borde antes de volver a pasear."
        min={5}
        max={1800}
        step={5}
        value={cfg.sleepTime}
        fmt={dur}
        onChange={(v) => set({ sleepTime: v })}
      />
      <Row
        label="Frecuencia de salto"
        hint="Cada cuánto saltan sobre el cursor de un amigo (desde cada minuto hasta 1 vez/hora, o nunca)."
        min={0}
        max={3600}
        step={30}
        value={cfg.jumpEvery}
        fmt={(v) => (v <= 0 ? "nunca" : dur(v))}
        onChange={(v) => set({ jumpEvery: v })}
      />
      <Row
        label="Velocidad al correr"
        hint="Qué tan rápido corren al huir o al lanzarse."
        min={0.1}
        max={0.6}
        step={0.02}
        value={cfg.runSpeed}
        fmt={(v) => `${Math.round((v / 0.26) * 100)}%`}
        onChange={(v) => set({ runSpeed: v })}
      />
      <button
        onClick={() => set({ allowLeap: !cfg.allowLeap })}
        className="flex items-center justify-between gap-3 w-full text-sm py-1"
      >
        <span className="flex flex-col items-start">
          <span>Saltar sobre amigos</span>
          <span className="text-xs text-white/40 text-left">
            {cfg.allowLeap
              ? "Se cuelgan del cursor del otro."
              : "Modo tranquilo: solo se arrastran y caen, no saltan."}
          </span>
        </span>
        <span
          className={`shrink-0 w-11 h-6 rounded-full relative transition ${
            cfg.allowLeap ? "bg-bichito-accent" : "bg-white/15"
          }`}
        >
          <span
            className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all ${
              cfg.allowLeap ? "left-[22px]" : "left-0.5"
            }`}
          />
        </span>
      </button>
      <div className="text-xs text-white/40 text-center py-1">
        {status === "saving" ? "Guardando y sincronizando…" : "Sincronizado con el grupo ✓"}
      </div>
    </div>
  );
}
