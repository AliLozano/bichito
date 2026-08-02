import { useState } from "react";
import { CHARACTERS, type CharacterId } from "../lib/characters";
import { Character } from "../components/Character";

export function Onboarding({
  initialName,
  initialCharacter,
  onDone,
}: {
  initialName: string;
  initialCharacter: CharacterId;
  onDone: (name: string, character: CharacterId) => void;
}) {
  const [name, setName] = useState(initialName);
  const [character, setCharacter] = useState<CharacterId>(initialCharacter);
  const valid = name.trim().length >= 2;

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <div className="w-full max-w-md bg-bichito-panel rounded-2xl p-7 shadow-xl border border-white/5">
        <h1 className="text-2xl font-bold mb-1">
          Hola 👋 soy tu <span className="text-bichito-accent">bichito</span>
        </h1>
        <p className="text-white/60 text-sm mb-6">
          Vivo en tu barra de tareas y de rato en rato salto sobre tus amigos.
        </p>

        <label className="block text-sm text-white/70 mb-2">¿Cómo te llamas?</label>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Tu nombre"
          maxLength={24}
          className="w-full mb-6 px-4 py-3 rounded-xl bg-black/30 border border-white/10 outline-none focus:border-bichito-accent transition"
        />

        <label className="block text-sm text-white/70 mb-3">Elige tu personaje</label>
        <div className="grid grid-cols-4 gap-3 mb-7">
          {CHARACTERS.map((c) => (
            <button
              key={c.id}
              onClick={() => setCharacter(c.id)}
              className={`flex flex-col items-center gap-1 py-3 rounded-xl border transition ${
                character === c.id
                  ? "border-bichito-accent bg-bichito-accent/10"
                  : "border-white/10 hover:border-white/25"
              }`}
            >
              <Character id={c.id} pose="idle" size={40} />
              <span className="text-[11px] text-white/70">{c.name}</span>
            </button>
          ))}
        </div>

        <button
          disabled={!valid}
          onClick={() => onDone(name.trim(), character)}
          className="w-full py-3 rounded-xl font-semibold bg-bichito-accent text-black disabled:opacity-40 disabled:cursor-not-allowed hover:brightness-110 transition"
        >
          ¡Empezar!
        </button>
      </div>
    </div>
  );
}
