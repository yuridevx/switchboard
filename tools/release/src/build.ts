// Сборка выпуска Host из монорепо: ядро и модули из host/core/modules.json, с пакетами, которые они импортируют.
//
// Папка выпуска — маленький монорепо npm; keeper ставит его как любое приложение по app.json:
//   app.json                 run: node host; setup: npm ci --omit=dev; detach_children — держатели сессий переживают Host
//   host                     вход: импортирует packages/host/main.ts
//   package.json             workspaces: packages/*
//   package-lock.json        зависимости (SDK и его пакеты) — npm ci на машине
//   packages/host/           ядро; release.json — версия выпуска
//   packages/<имя>/          модули и пакеты, которые они импортируют
// npm ci связывает пакеты в node_modules/@switchboard ссылками на packages/: настоящий путь файлов — вне node_modules,
// поэтому Node снимает типы с .ts сам, без сборки в .js.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { shaLine, VERSION_RE } from "./format.ts";
import { sha256hex } from "./hash.ts";
import type { RunResult } from "./run.ts";
import { pack } from "./tar.ts";
import type { TarFile } from "./tar.ts";

export type Exec = (cmd: "npm" | "node", args: string[], cwd: string) => Promise<RunResult>;

export type BuildOptions = {
  /** корень монорепо */
  root: string;
  version: string;
  /** куда класть папку выпуска, .tgz и .sha256 */
  out: string;
  exec: Exec;
};

export type Built = {
  version: string;
  /** папка выпуска без node_modules */
  dir: string;
  tgz: Buffer;
  sha: string;
  /** пакеты выпуска по имени */
  packages: string[];
  /** ответ host --check */
  check: { ok: boolean; version?: string; sdk?: string; proto?: number; why?: string };
};

const SKIP_DIRS = new Set(["node_modules", "dist", ".wrangler", "test", "tests"]);
const SKIP_FILE = /(\.test\.|\.spec\.|^vitest\.config\.|^tsconfig.*\.json$|^wrangler\.(jsonc?|toml)$|^\.dev\.vars)/;
const SRC = /\.(ts|tsx|mts|js|mjs)$/;
const IMPORT = /(?:from\s*|import\s*\(\s*|import\s+)["'](@switchboard\/[^"'/]+)/g;

/** Пакеты workspaces монорепо: имя → папка. */
export function workspaces(root: string): Map<string, string> {
  const pj = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { workspaces?: string[] };
  const out = new Map<string, string>();
  const add = (d: string) => {
    const f = join(d, "package.json");
    if (existsSync(f)) out.set(JSON.parse(readFileSync(f, "utf8")).name, d);
  };
  for (const g of pj.workspaces ?? []) {
    if (!g.endsWith("/*")) {
      add(join(root, g));
      continue;
    }
    const base = join(root, g.slice(0, -2));
    if (!existsSync(base)) continue;
    for (const d of readdirSync(base)) if (statSync(join(base, d)).isDirectory()) add(join(base, d));
  }
  return out;
}

/** Файлы пакета, которые идут в выпуск: без тестов, настроек сборки и node_modules. Пути — через «/». */
export function packageFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(join(d, e.name));
      } else if (e.isFile() && !SKIP_FILE.test(e.name)) out.push(relative(dir, join(d, e.name)).split(sep).join("/"));
    }
  };
  walk(dir);
  return out.sort();
}

/** Пакеты @switchboard, которые импортирует код пакета. */
function importsOf(dir: string, files: string[]): string[] {
  const found = new Set<string>();
  for (const f of files) {
    if (!SRC.test(f) || f.endsWith(".d.ts")) continue;
    for (const m of readFileSync(join(dir, f), "utf8").matchAll(IMPORT)) found.add(m[1]);
  }
  return [...found];
}

/** package.json пакета в выпуске: без скриптов и зависимостей разработки; пакеты @switchboard связывает workspaces. */
function releasePackageJson(src: Record<string, any>): Record<string, unknown> {
  const deps = Object.fromEntries(Object.entries((src.dependencies ?? {}) as Record<string, string>).filter(([n]) => !n.startsWith("@switchboard/")));
  const out: Record<string, unknown> = { name: src.name, version: src.version, private: true, type: src.type ?? "module" };
  if (src.exports) out.exports = src.exports;
  if (src.bin) out.bin = src.bin;
  if (Object.keys(deps).length) out.dependencies = deps;
  if (src.optionalDependencies) out.optionalDependencies = src.optionalDependencies;
  return out;
}

/** Пакеты выпуска: ядро, модули списка и всё, что они импортируют. */
export function closure(root: string): Array<{ name: string; dir: string }> {
  const ws = workspaces(root);
  const coreDir = ws.get("@switchboard/host");
  if (!coreDir) throw new Error("пакета @switchboard/host нет в workspaces");
  const names = JSON.parse(readFileSync(join(coreDir, "modules.json"), "utf8")) as string[];
  const queue = ["@switchboard/host", ...names.map((n) => `@switchboard/${n}`)];
  const seen = new Map<string, string>();
  while (queue.length) {
    const name = queue.shift()!;
    if (seen.has(name)) continue;
    const dir = ws.get(name);
    if (!dir) throw new Error(`пакета ${name} нет в workspaces`);
    seen.set(name, dir);
    queue.push(...importsOf(dir, packageFiles(dir)));
  }
  return [...seen].map(([name, dir]) => ({ name, dir }));
}

/** app.json Host: часть машины, как любое приложение. */
export const APP = { run: ["node", "host"], setup: ["npm", "ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], detach_children: true };

const ENTRY = `// Вход выпуска Host: keeper запускает node host в папке версии.
import "./packages/host/main.ts";
`;

/** Ответ host --check: последняя строка JSON вывода. */
export function parseCheck(out: string): Built["check"] {
  const line = out.trim().split("\n").reverse().find((l) => l.trim().startsWith("{"));
  try {
    return line ? JSON.parse(line) : { ok: false, why: out.trim() || "host --check без ответа" };
  } catch {
    return { ok: false, why: out.trim() };
  }
}

/** Собрать выпуск: папка, lockfile, npm ci и host --check, архив и его SHA-256. Не прошло — исключение с причиной. */
export async function build(o: BuildOptions): Promise<Built> {
  if (!VERSION_RE.test(o.version)) throw new Error(`версия «${o.version}» не вида 1.4.1`);
  const pkgs = closure(o.root);
  const dir = join(o.out, o.version);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const files: TarFile[] = [];
  const put = (path: string, data: Buffer, mode?: number) => {
    const p = join(dir, ...path.split("/"));
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, data, mode ? { mode } : {});
  };
  for (const { name, dir: src } of pkgs) {
    const base = `packages/${name.slice("@switchboard/".length)}`;
    for (const f of packageFiles(src)) if (f !== "package.json") put(`${base}/${f}`, readFileSync(join(src, f)));
    const pj = releasePackageJson(JSON.parse(readFileSync(join(src, "package.json"), "utf8")));
    put(`${base}/package.json`, Buffer.from(JSON.stringify(pj, null, 2) + "\n"));
  }
  put("packages/host/release.json", Buffer.from(JSON.stringify({ version: o.version }) + "\n"));
  put("app.json", Buffer.from(JSON.stringify(APP) + "\n"));
  put("package.json", Buffer.from(JSON.stringify({ name: "switchboard-host-release", version: o.version, private: true, type: "module", workspaces: ["packages/*"] }, null, 2) + "\n"));
  put("host", Buffer.from(ENTRY), 0o755);

  const lock = await o.exec("npm", ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"], dir);
  if (lock.code !== 0) throw new Error(`npm install --package-lock-only: ${lock.out.trim()}`);
  const ci = await o.exec("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], dir);
  if (ci.code !== 0) throw new Error(`npm ci: ${ci.out.trim()}`);
  const check = parseCheck((await o.exec("node", ["host", "--check"], dir)).out);
  rmSync(join(dir, "node_modules"), { recursive: true, force: true });
  if (!check.ok) throw new Error(`host --check: ${check.why}`);
  if (check.version !== o.version) throw new Error(`host --check: версия ${check.version}, а собиралась ${o.version}`);

  for (const f of packageFiles(dir)) files.push({ path: f, data: readFileSync(join(dir, ...f.split("/"))), ...(f === "host" ? { mode: 0o755 } : {}) });
  const tgz = pack(files);
  const sha = sha256hex(tgz);
  writeFileSync(join(o.out, `${o.version}.tgz`), tgz);
  writeFileSync(join(o.out, `${o.version}.sha256`), shaLine(sha, o.version));
  return { version: o.version, dir, tgz, sha, packages: pkgs.map((p) => p.name), check };
}
