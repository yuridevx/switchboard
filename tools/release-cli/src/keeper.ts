// Архив keeper: файлы для Windows и Linux одним архивом, манифест первым; номер — из os/keeper/module.json.
// Сборка без путей, дат и сведений git: иначе Go вшивает ревизию коммита и хэш меняется с каждым коммитом (CI 1 нояб.: «keeper/0.5.2 уже есть с другим хэшем»).
// Тот же код той же версии Go — тот же хэш.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pack, sha256hex, type TarFile } from "@switchboard/release";
import { run, type Ran } from "./spawn.ts";

export type GoExec = (args: string[], cwd: string, env: Record<string, string>) => Promise<Ran>;
export const runGo: GoExec = (args, cwd, env) => run("go", args, cwd, { env });

const TARGETS = [
  { goos: "windows", file: "windows-amd64/keeper.exe" },
  { goos: "linux", file: "linux-amd64/keeper" },
];

/** Собрать и упаковать. Не собрался — исключение с выводом go. */
export async function buildKeeper(root: string, go: GoExec): Promise<{ version: string; tgz: Buffer; sha: string }> {
  const dir = join(root, "os", "keeper");
  const manifest = readFileSync(join(dir, "module.json"));
  const { version } = JSON.parse(manifest.toString("utf8")) as { version: string };
  const tmp = mkdtempSync(join(tmpdir(), "switchboard-keeper-"));
  try {
    const files: TarFile[] = [{ path: "module.json", data: manifest, mode: 0o644 }];
    for (const { goos, file } of TARGETS) {
      const out = join(tmp, ...file.split("/"));
      const r = await go(["build", "-trimpath", "-buildvcs=false", "-ldflags", "-s -w -buildid=", "-o", out, "."], dir, { GOOS: goos, GOARCH: "amd64", CGO_ENABLED: "0" });
      if (r.code !== 0) throw new Error(`go build ${goos}/amd64: ${r.out.trim()}`);
      files.push({ path: file, data: readFileSync(out), mode: 0o755 });
    }
    const tgz = pack(files);
    return { version, tgz, sha: sha256hex(tgz) };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
