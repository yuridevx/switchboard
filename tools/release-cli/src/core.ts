// Архив ядра Host для каталога: ядро, пакеты, которые оно импортирует, и то, что оно даёт модулям (зависимости @switchboard
// из его package.json), без модулей: модули и список кладут «Выпуски» при сборке.
//
// Папка ядра — маленький монорепо npm; keeper ставит сборку как любое приложение по app.json:
//   module.json          манифест ядра — первой записью архива
//   app.json             run: node host; setup: npm ci; detach_children — держатели сессий переживают Host
//   host                 вход: импортирует packages/host/main.ts
//   package.json         workspaces: packages/*
//   package-lock.json    зависимости — npm ci на машине
//   packages/<имя>/      ядро и его пакеты
// В сборке рядом — modules/<имя>/ и build.json; modules/ вне workspaces: импорты модулей Node находит в node_modules корня.
// npm ci связывает пакеты ссылками на packages/: настоящий путь файлов — вне node_modules, поэтому Node снимает типы с .ts сам.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pack, packageFiles, sha256hex, shaLine, type TarFile } from "@switchboard/release";
import { importsOf, readJson, workspaces } from "./graph.ts";
import type { Ran } from "./spawn.ts";

export type Exec = (cmd: "npm" | "node", args: string[], cwd: string) => Promise<Ran>;

const SCOPE = "@switchboard/";
const QUIET = ["--ignore-scripts", "--no-audit", "--no-fund"];
const NPM_CI = ["ci", "--omit=dev", ...QUIET];
const APP = { run: ["node", "host"], setup: ["npm", ...NPM_CI], detach_children: true };
const ENTRY = `// Вход выпуска Host: keeper запускает node host в папке версии.\nimport "./packages/host/main.ts";\n`;

type Pkg = { name: string; version?: string; type?: string; exports?: unknown; bin?: unknown; dependencies?: Record<string, string>; optionalDependencies?: unknown };

/** Пакеты ядра в порядке обхода: ядро первым. */
function corePackages(root: string): Array<{ name: string; dir: string }> {
  const known = workspaces(root);
  const seen = new Map<string, string>();
  const queue = [`${SCOPE}host`];
  for (const name of queue) {
    if (seen.has(name)) continue;
    const dir = known.get(name);
    if (!dir) throw new Error(`пакета ${name} нет в workspaces`);
    seen.set(name, dir);
    const deps = Object.keys(readJson<Pkg>(join(dir, "package.json")).dependencies ?? {}).filter((d) => d.startsWith(SCOPE));
    queue.push(...importsOf(dir), ...deps);
  }
  return [...seen].map(([name, dir]) => ({ name, dir }));
}

/** package.json пакета в выпуске: без скриптов и разработки; пакеты @switchboard связывает workspaces. */
function releasedPackageJson(p: Pkg): Buffer {
  const deps = Object.entries(p.dependencies ?? {}).filter(([n]) => !n.startsWith(SCOPE));
  const out = {
    name: p.name,
    version: p.version,
    private: true,
    type: p.type ?? "module",
    ...(p.exports ? { exports: p.exports } : {}),
    ...(p.bin ? { bin: p.bin } : {}),
    ...(deps.length ? { dependencies: Object.fromEntries(deps) } : {}),
    ...(p.optionalDependencies ? { optionalDependencies: p.optionalDependencies } : {}),
  };
  return json(out);
}
const json = (x: unknown) => Buffer.from(`${JSON.stringify(x, null, 2)}\n`);

export const coreVersion = (root: string) => readJson<{ version: string }>(join(root, "host", "core", "module.json")).version;

/** Файлы архива ядра, кроме lockfile: его пишет npm. */
export function coreFiles(root: string): TarFile[] {
  const version = coreVersion(root);
  const packages = corePackages(root);
  const out: TarFile[] = packages.flatMap(({ name, dir }) => {
    const base = `packages/${name.slice(SCOPE.length)}`;
    const own = packageFiles(dir).filter((f) => f !== "package.json");
    return [...own.map((f) => ({ path: `${base}/${f}`, data: readFileSync(join(dir, ...f.split("/"))) })), { path: `${base}/package.json`, data: releasedPackageJson(readJson<Pkg>(join(dir, "package.json"))) }];
  });
  return [
    ...out,
    { path: "module.json", data: readFileSync(join(packages[0].dir, "module.json")) },
    { path: "app.json", data: Buffer.from(`${JSON.stringify(APP)}\n`) },
    { path: "package.json", data: json({ name: "switchboard-host-release", version, private: true, type: "module", workspaces: ["packages/*"] }) },
    { path: "host", data: Buffer.from(ENTRY), mode: 0o755 },
  ];
}

type Check = { ok: boolean; version?: string; sdk?: string; proto?: number; why?: string };

/** Ответ host --check: последняя строка JSON вывода. */
function parseCheck(out: string): Check {
  const line = out.trim().split("\n").findLast((l) => l.trim().startsWith("{"));
  if (!line) return { ok: false, why: out.trim() || "host --check без ответа" };
  try {
    return JSON.parse(line) as Check;
  } catch {
    return { ok: false, why: out.trim() };
  }
}

/** Собрать архив ядра в out: папка, lockfile, npm ci и host --check, .tgz и .sha256. Не прошло — исключение с причиной, архива нет. */
export async function buildCore(root: string, out: string, exec: Exec): Promise<{ version: string; tgz: Buffer; sha: string; packages: number; sdk?: string }> {
  const version = coreVersion(root);
  const dir = join(out, version);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const place = (path: string, data: Buffer, mode?: number) => {
    const at = join(dir, ...path.split("/"));
    mkdirSync(dirname(at), { recursive: true });
    writeFileSync(at, data, mode ? { mode } : {});
  };
  for (const f of coreFiles(root)) place(f.path, f.data, f.mode);
  // версии зависимостей — из lock-файла монорепо: npm сужает его до пакетов ядра, а не разрешает заново по реестру
  // (иначе новый патч в реестре меняет архив той же версии ядра от прогона к прогону)
  place("package-lock.json", readFileSync(join(root, "package-lock.json")));
  const step = async (word: string, args: string[]) => {
    const r = await exec("npm", args, dir);
    if (r.code !== 0) throw new Error(`${word}: ${r.out.trim()}`);
  };
  await step("npm install --package-lock-only", ["install", "--package-lock-only", ...QUIET]);
  await step("npm ci", NPM_CI);
  const check = parseCheck((await exec("node", ["host", "--check"], dir)).out);
  rmSync(join(dir, "node_modules"), { recursive: true, force: true });
  if (!check.ok) throw new Error(`host --check: ${check.why}`);
  if (check.version !== version) throw new Error(`host --check: версия ${check.version}, а собиралась ${version}`);

  const tgz = pack(packageFiles(dir).map((path) => ({ path, data: readFileSync(join(dir, ...path.split("/"))), ...(path === "host" ? { mode: 0o755 } : {}) })));
  const sha = sha256hex(tgz);
  writeFileSync(join(out, `${version}.tgz`), tgz);
  writeFileSync(join(out, `${version}.sha256`), shaLine(sha, version));
  return { version, tgz, sha, packages: corePackages(root).length, sdk: check.sdk };
}
