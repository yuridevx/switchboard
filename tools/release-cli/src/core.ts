// Архив ядра Host: само ядро и его пакеты рабочей области без модулей; lockfile пишет npm, host --check подтверждает сборку.
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadRepo } from "@switchboard/manifest-gate";
import { MANIFEST, pack, packageFiles, sha256hex, shaLine, type TarFile } from "@switchboard/release";
import { ROOT } from "./module.ts";
import type { Ran } from "./spawn.ts";

export type Exec = (cmd: string, args: string[], cwd: string) => Promise<Ran>;

const SCOPE = "@switchboard/";
const NPM_FLAGS = ["--ignore-scripts", "--no-audit", "--no-fund"];
const ENTRY = '// Вход выпуска Host: keeper запускает node host в папке версии.\nimport "./packages/host/main.ts";\n';

const json = (x: unknown) => JSON.stringify(x, null, 2) + "\n";

type PackageJson = { name: string; scripts?: unknown; dependencies?: Record<string, string>; devDependencies?: unknown };

const readPackage = (dir: string) => JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as PackageJson;

/** Ядро и пакеты, которые импортирует его код и код этих пакетов. */
function corePackages(): Array<{ short: string; dir: string; pj: PackageJson }> {
  const repo = loadRepo(ROOT);
  const byPkg = new Map(repo.flatMap((m) => (m.pkg ? [[m.pkg, m] as const] : [])));
  const seen = new Map<string, { short: string; dir: string; pj: PackageJson }>();
  const visit = (name: string) => {
    const m = byPkg.get(name);
    if (!m || seen.has(name)) return;
    const dir = join(ROOT, m.dir);
    const pj = readPackage(dir);
    seen.set(name, { short: name.slice(SCOPE.length), dir, pj });
    for (const spec of [...(m.imports ?? []), ...Object.keys(pj.dependencies ?? {})]) visit(spec.split("/").slice(0, 2).join("/"));
  };
  visit(`${SCOPE}host`);
  return [...seen.values()];
}

/** package.json в архиве: без команд и инструментов разработки; свои пакеты связывает рабочая область. */
function releasedPackage({ scripts: _s, devDependencies: _d, dependencies, ...rest }: PackageJson): string {
  const external = Object.entries(dependencies ?? {}).filter(([d]) => !d.startsWith(SCOPE));
  return json({ ...rest, ...(external.length ? { dependencies: Object.fromEntries(external) } : {}) });
}

/** Файлы ядра без lockfile: их же сверяет release check. */
export function coreFiles(): { version: string; files: TarFile[]; packages: number } {
  const packages = corePackages();
  const manifest = readFileSync(join(ROOT, "host/core/module.json"));
  const { version } = JSON.parse(manifest.toString("utf8")) as { version: string };
  const files: TarFile[] = [
    { path: MANIFEST, data: manifest },
    { path: "host", data: Buffer.from(ENTRY), mode: 0o755 },
    { path: "package.json", data: Buffer.from(json({ name: "switchboard-host-release", version, private: true, type: "module", workspaces: ["packages/*"] })) },
    { path: "app.json", data: Buffer.from(JSON.stringify({ run: ["node", "host"], setup: ["npm", "ci", "--omit=dev", ...NPM_FLAGS], detach_children: true }) + "\n") },
  ];
  for (const { short, dir, pj } of packages) {
    for (const f of packageFiles(dir)) files.push({ ...f, path: `packages/${short}/${f.path}`, data: f.path === "package.json" ? Buffer.from(releasedPackage(pj)) : f.data });
  }
  return { version, files, packages: packages.length };
}

function step(r: Ran, name: string): void {
  if (r.code !== 0) throw new Error(`${name}: ${r.out.trim()}`);
}

/** Ответ host --check: последняя строка-объект вывода. */
function checked(r: Ran, version: string): { sdk: string } {
  const at = r.out.lastIndexOf("{");
  if (at < 0) throw new Error(`host --check: ${r.out.trim() || "host --check без ответа"}`);
  let a: { ok?: boolean; why?: string; version?: string; sdk?: string };
  try {
    a = JSON.parse(r.out.slice(at));
  } catch {
    throw new Error(`host --check: ${r.out.trim()}`);
  }
  if (!a.ok) throw new Error(`host --check: ${a.why}`);
  if (a.version !== version) throw new Error(`host --check: версия ${a.version}, а собиралась ${version}`);
  return { sdk: String(a.sdk) };
}

/** Файлы папки сборки, кроме node_modules: те, что положили мы, и lockfile. */
function lockOf(dir: string): TarFile[] {
  return readdirSync(dir).includes("package-lock.json") ? [{ path: "package-lock.json", data: readFileSync(join(dir, "package-lock.json")) }] : [];
}

/** Собрать ядро в <out>/<версия>: npm и host --check по порядку, затем .tgz и .sha256 рядом; папка остаётся без node_modules. */
export async function buildCore(out: string, exec: Exec): Promise<{ version: string; tgz: Buffer; sha: string; line: string }> {
  const { version, files, packages } = coreFiles();
  const dir = join(out, version);
  rmSync(dir, { recursive: true, force: true });
  for (const f of files) {
    mkdirSync(dirname(join(dir, f.path)), { recursive: true });
    writeFileSync(join(dir, f.path), f.data);
  }
  step(await exec("npm", ["install", "--package-lock-only", ...NPM_FLAGS], dir), "npm install --package-lock-only");
  step(await exec("npm", ["ci", "--omit=dev", ...NPM_FLAGS], dir), "npm ci");
  const { sdk } = checked(await exec("node", ["host", "--check"], dir), version);
  rmSync(join(dir, "node_modules"), { recursive: true, force: true });
  const tgz = pack([...files, ...lockOf(dir)]);
  const sha = sha256hex(tgz);
  writeFileSync(join(out, `${version}.tgz`), tgz);
  writeFileSync(join(out, `${version}.sha256`), shaLine(sha, version));
  return { version, tgz, sha, line: `собрано ядро host ${version}: ${packages} пакетов · SDK ${sdk} · ${tgz.length} байт · sha256 ${sha}` };
}

