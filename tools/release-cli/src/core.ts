// Ядро Host в каталог: пакеты ядра и его зависимости без модулей и тестов; npm ставит их, host --check подтверждает выпуск.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadRepo } from "@switchboard/manifest-gate";
import { MANIFEST, pack, packageFiles, sha256hex, type TarFile } from "@switchboard/release";
import type { Done } from "./spawn.ts";

export type Exec = (cmd: string, args: string[], cwd: string) => Promise<Done>;

const SCOPE = "@switchboard/";
const QUIET = ["--ignore-scripts", "--no-audit", "--no-fund"];
const LOCK = "package-lock.json";
const ENTRY = '// Вход выпуска Host: keeper запускает node host в папке версии.\nimport "./packages/host/main.ts";\n';

const json = (value: unknown) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

/** Пакет в выпуске: зависимости монорепо дают workspaces, скрипты не нужны. */
function released(data: Buffer): Buffer {
  const { scripts: _s, devDependencies: _d, dependencies, ...pkg } = JSON.parse(data.toString("utf8")) as Record<string, unknown> & { dependencies?: Record<string, string> };
  const outside = Object.entries(dependencies ?? {}).filter(([name]) => !name.startsWith(SCOPE));
  return json(outside.length ? { ...pkg, dependencies: Object.fromEntries(outside) } : pkg);
}

/** Пакеты, которые импортирует код ядра и которые названы в зависимостях, — и то же у них. */
function packagesOf(root: string) {
  const repo = loadRepo(root);
  const core = repo.find((m) => m.type === "sdk-core")!;
  const seen = new Set([core]);
  for (const m of seen) {
    const { dependencies = {} } = JSON.parse(readFileSync(join(root, m.dir, "package.json"), "utf8")) as { dependencies?: Record<string, string> };
    for (const spec of [...(m.imports ?? []), ...Object.keys(dependencies)]) {
      const pkg = spec.split("/").slice(0, 2).join("/");
      const dep = repo.find((x) => x.pkg === pkg);
      if (dep) seen.add(dep);
    }
  }
  return { core, packages: [...seen] };
}

function filesOf(root: string) {
  const { core, packages } = packagesOf(root);
  const files: TarFile[] = packages.flatMap((m) =>
    packageFiles(join(root, m.dir)).map((f) => ({ path: `packages/${m.pkg!.slice(SCOPE.length)}/${f.path}`, data: f.path === "package.json" ? released(f.data) : f.data })),
  );
  const setup = ["npm", "ci", "--omit=dev", ...QUIET];
  files.push(
    { path: MANIFEST, data: readFileSync(join(root, core.dir, MANIFEST)) },
    { path: "host", data: Buffer.from(ENTRY), mode: 0o755 },
    { path: "package.json", data: json({ name: "switchboard-host-release", version: core.version, private: true, type: "module", workspaces: ["packages/*"] }) },
    { path: "app.json", data: Buffer.from(`${JSON.stringify({ run: ["node", "host"], setup, detach_children: true })}
`) },
  );
  return { version: core.version, files, count: packages.length };
}

/** Ответ host --check: последняя строка-объект вывода; после неё бывает шум. */
function checked(r: Done, version: string): { sdk: string } {
  const fail = (why: unknown) => new Error(`host --check: ${why}`);
  const line = r.out.split("\n").findLast((l) => l.startsWith("{"));
  if (!line) throw fail("host --check без ответа");
  let answer: { ok?: boolean; why?: string; version?: string; sdk: string };
  try {
    answer = JSON.parse(line);
  } catch {
    throw fail(line);
  }
  if (!answer.ok) throw fail(answer.why);
  if (answer.version !== version) throw fail(`версия ${answer.version}, а собиралась ${version}`);
  return answer;
}

/** Файлы ядра без lockfile: их сверяет release check, npm для этого не нужен. */
export function coreArchive(root: string) {
  const { version, files } = filesOf(root);
  const tgz = pack(files);
  return { name: "host", version, tgz, sha: sha256hex(tgz) };
}

export async function buildCore(root: string, exec: Exec, out?: string) {
  const { version, files, count } = filesOf(root);
  const dir = join(out ?? mkdtempSync(join(tmpdir(), "switchboard-core-")), version);
  rmSync(dir, { recursive: true, force: true });
  for (const f of files) {
    mkdirSync(dirname(join(dir, f.path)), { recursive: true });
    writeFileSync(join(dir, f.path), f.data);
  }
  const step = async (word: string, cmd: string, args: string[]) => {
    const r = await exec(cmd, args, dir);
    if (r.code !== 0) throw new Error(`${word}: ${r.out.trim()}`);
  };
  await step("npm install --package-lock-only", "npm", ["install", "--package-lock-only", ...QUIET]);
  await step("npm ci", "npm", ["ci", "--omit=dev", ...QUIET]);
  const { sdk } = checked(await exec("node", ["host", "--check"], dir), version);
  rmSync(join(dir, "node_modules"), { recursive: true, force: true });
  const tgz = pack([...files, { path: LOCK, data: readFileSync(join(dir, LOCK)) }]);
  const sha = sha256hex(tgz);
  console.log(`собрано ядро host ${version}: ${count} пакетов · SDK ${sdk} · ${tgz.length} байт · sha256 ${sha}`);
  if (!out) rmSync(dirname(dir), { recursive: true });
  return { name: "host", version, tgz, sha };
}
