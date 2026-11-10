// Отпечаток кода сборки: один хэш от собранного Host (без номера сборки) и исходников Keeper. Архивы и бинарники от запуска к запуску
// разные (время в tar, метки сборки), поэтому сверяется не файл, а то, из чего он собран.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

/** Опции сборки Host — одни для сборки и для отпечатка. */
export const hostBundle = (root) => ({
  entryPoints: [path.join(root, "host/src/main.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  external: ["@anthropic-ai/claude-agent-sdk"],
  logLevel: "warning",
});

export async function digest(root) {
  const require = createRequire(path.join(root, "package.json"));
  const out = await require("esbuild").build({ ...hostBundle(root), write: false });
  const h = crypto.createHash("sha256");
  // переводы строк исходников на Windows и Linux разные: в отпечаток идут строки, а не байты файла
  const text = (s) => h.update(s.replace(/\r\n/g, "\n"));
  text(out.outputFiles[0].text);
  const sdk = JSON.parse(fs.readFileSync(path.join(root, "host/package.json"), "utf8")).dependencies["@anthropic-ai/claude-agent-sdk"];
  text("sdk " + sdk);
  const keeper = path.join(root, "keeper");
  for (const name of fs.readdirSync(keeper).filter((n) => (n.endsWith(".go") && !n.endsWith("_test.go")) || n === "go.mod" || n === "go.sum").sort()) {
    text(name);
    text(fs.readFileSync(path.join(keeper, name), "utf8"));
  }
  return h.digest("hex");
}
