import { useEffect, useState } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

// Auto-updater UI: checks the signed manifest on GitHub Releases, and if a newer
// version exists, offers to download + install it and relaunch.
type State = "checking" | "none" | "available" | "downloading" | "error";

export function Updater() {
  const [state, setState] = useState<State>("checking");
  const [update, setUpdate] = useState<Update | null>(null);
  const [err, setErr] = useState("");

  const doCheck = async () => {
    setState("checking");
    setErr("");
    try {
      const u = await check();
      if (u) {
        setUpdate(u);
        setState("available");
      } else {
        setState("none");
      }
    } catch (e: any) {
      setErr(String(e?.message ?? e));
      setState("error");
    }
  };

  useEffect(() => {
    doCheck();
  }, []);

  const install = async () => {
    if (!update) return;
    setState("downloading");
    try {
      await update.downloadAndInstall();
      await relaunch();
    } catch (e: any) {
      setErr(String(e?.message ?? e));
      setState("error");
    }
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between text-sm">
        <span>Actualizaciones</span>
        {state === "available" ? (
          <button
            onClick={install}
            disabled={false}
            className="px-3 py-1.5 rounded-lg bg-bichito-accent/25 hover:bg-bichito-accent/40 text-sm transition"
          >
            Actualizar a {update?.version}
          </button>
        ) : (
          <button
            onClick={doCheck}
            disabled={state === "checking" || state === "downloading"}
            className="px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/15 text-sm transition disabled:opacity-50"
          >
            {state === "checking" ? "Buscando…" : "Buscar"}
          </button>
        )}
      </div>
      <div className="text-xs text-white/40">
        {state === "checking" && "Buscando actualizaciones…"}
        {state === "available" && `Nueva versión ${update?.version} disponible 🎉`}
        {state === "downloading" && "Descargando e instalando… (se reiniciará)"}
        {state === "none" && "Estás en la última versión ✓"}
        {state === "error" && `No se pudo verificar: ${err}`}
      </div>
    </div>
  );
}
