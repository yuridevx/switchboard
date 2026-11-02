// Архив keeper: файлы для Windows и Linux одним архивом — windows-amd64/keeper.exe и linux-amd64/keeper.
// Сборка без путей, дат и сведений git (-trimpath, пустой buildid, -buildvcs=false: иначе Go вшивает ревизию коммита
// и хэш меняется с каждым коммитом — CI 1 нояб.: «keeper/0.5.2 уже есть с другим хэшем»), упаковка без дат:
// тот же код той же версии Go — тот же хэш.
// Номер — из os/keeper/module.json.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pack, sha256hex } from "@switchboard/release";
import type { RunResult } from "./run.ts";

export const TARGETS = [
  { goos: "windows", goarch: "amd64", file: "windows-amd64/keeper.exe" },
  { goos: "linux", goarch: "amd64", file: "linux-amd64/keeper" },
] as const;

export type GoExec = (args: string[], cwd: string, env: Record<string, string>) => Promise<RunResult>;

export const runGo: GoExec = (args, cwd, env) =>
  new Promise((res) => {
    const p = spawn("go", args, { cwd, env: { ...process.env, ...env }, windowsHide: true });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("error", (e) => res({ code: null, out: out + e.message }));
    p.on("close", (code) => res({ code, out }));
  });

/** Собрать keeper для двух ОС и упаковать. Не собрался — исключение с выводом go. */
export async function buildKeeper(root: string, go: GoExec = runGo): Promise<{ version: string; tgz: Buffer; sha: string }> {
  const dir = join(root, "os", "keeper");
  const version = (JSON.parse(readFileSync(join(dir, "module.json"), "utf8")) as { version: string }).version;
  const tmp = mkdtempSync(join(tmpdir(), "switchboard-keeper-"));
  try {
    const files = [];
    for (const t of TARGETS) {
      const out = join(tmp, ...t.file.split("/"));
      const r = await go(["build", "-trimpath", "-buildvcs=false", "-ldflags", "-s -w -buildid=", "-o", out, "."], dir, { GOOS: t.goos, GOARCH: t.goarch, CGO_ENABLED: "0" });
      if (r.code !== 0) throw new Error(`go build ${t.goos}/${t.goarch}: ${r.out.trim()}`);
      files.push({ path: t.file, data: readFileSync(out), mode: 0o755 });
    }
    // манифест — первой записью: «Выпуски» сверяют по нему набор флота
    files.push({ path: "module.json", data: readFileSync(join(dir, "module.json")), mode: 0o644 });
    const tgz = pack(files);
    return { version, tgz, sha: sha256hex(tgz) };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
