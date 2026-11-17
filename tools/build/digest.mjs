// Отпечаток кода части: хэш от того, из чего она собрана. По нему выкладка решает, тронута ли часть: совпал с тем, что стоит, — не трогает.
// Правило одно для всех трёх частей: машины (собранный Host и исходники Keeper), платформа и службы (собранный Worker; у служб — ещё страница).
// Архивы и бинарники от запуска к запуску разные (время в tar, метки сборки), поэтому сверяется не файл, а то, из чего он собран.
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

/** Опции сборки Worker'а для отпечатка: тот же вход, что выкладывает wrangler. */
const workerBundle = (root, part) => ({
  entryPoints: [path.join(root, part, "src/index.ts")],
  bundle: true,
  platform: "neutral",
  format: "esm",
  mainFields: ["module", "main"],
  conditions: ["workerd", "worker", "browser"],
  external: ["cloudflare:*", "node:*"],
  logLevel: "warning",
});

const esbuild = (root) => createRequire(path.join(root, "package.json"))("esbuild");
// переводы строк исходников на Windows и Linux разные: в отпечаток идут строки, а не байты файла
const lines = (s) => s.replace(/\r\n/g, "\n");

/** Собранный код части и исходные файлы, которые в него вошли. */
async function bundle(root, part) {
  const out = await esbuild(root).build({ ...(part === "machines" ? hostBundle(root) : workerBundle(root, part)), write: false, metafile: true });
  return { text: lines(out.outputFiles[0].text), inputs: Object.keys(out.metafile.inputs).map((f) => f.replaceAll("\\", "/")) };
}

/** Исходные файлы, из которых собрана часть: так видно, что общий договор входит в каждую. */
export const inputs = async (root, part) => (await bundle(root, part)).inputs;

/** Отпечаток машин: собранный Host (без номера сборки), версия SDK и исходники Keeper. */
export async function digest(root) {
  const h = crypto.createHash("sha256");
  h.update((await bundle(root, "machines")).text);
  const sdk = JSON.parse(fs.readFileSync(path.join(root, "host/package.json"), "utf8")).dependencies["@anthropic-ai/claude-agent-sdk"];
  h.update("sdk " + sdk);
  const keeper = path.join(root, "keeper");
  for (const name of fs.readdirSync(keeper).filter((n) => (n.endsWith(".go") && !n.endsWith("_test.go")) || n === "go.mod" || n === "go.sum").sort()) {
    h.update(name);
    h.update(lines(fs.readFileSync(path.join(keeper, name), "utf8")));
  }
  return h.digest("hex");
}

/** Отпечаток Worker'а: собранный код и его настройка выкладки; у служб — ещё собранная страница (web/dist), её отдаёт тот же Worker. */
async function workerDigest(root, part) {
  const h = crypto.createHash("sha256");
  h.update((await bundle(root, part)).text);
  h.update(lines(fs.readFileSync(path.join(root, part, "wrangler.jsonc"), "utf8")));
  if (part === "services") {
    const dist = path.join(root, "web/dist");
    if (!fs.existsSync(path.join(dist, "index.html"))) throw new Error("страница не собрана: нет web/dist/index.html");
    for (const name of fs.readdirSync(dist, { recursive: true }).map(String).sort()) {
      const file = path.join(dist, name);
      if (!fs.statSync(file).isFile()) continue;
      h.update(name.replaceAll("\\", "/"));
      h.update(fs.readFileSync(file));
    }
  }
  return h.digest("hex");
}

/** Отпечатки всех трёх частей дерева. Страница к этому моменту собрана. */
export async function digests(root) {
  return { platform: await workerDigest(root, "platform"), services: await workerDigest(root, "services"), machines: await digest(root) };
}
