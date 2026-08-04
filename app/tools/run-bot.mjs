// Bundle tools/bot.ts (TypeScript) with the esbuild that's already a dependency, then
// run it with Node. Avoids adding tsx just for the headless friend bot. The bundle is
// written next to this file so Node resolves the `ws` external from app/node_modules.
import { build } from "esbuild";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "bot.built.mjs");

await build({
  entryPoints: [join(here, "bot.ts")],
  outfile: out,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  // ws (+ its optional native accelerators) stay external -> resolved from node_modules
  external: ["ws", "bufferutil", "utf-8-validate"],
  logLevel: "info",
});

const child = spawn(process.execPath, [out], { stdio: "inherit", env: process.env });
child.on("exit", (code) => process.exit(code ?? 0));
