// Keeper в каталог: два бинарника в одном архиве. Флаги убирают сведения git и пути: тот же код — те же байты.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lf, MANIFEST, pack, sha256hex } from "@switchboard/release";
import type { Done } from "./spawn.ts";

export type Go = (args: string[], cwd: string, env: Record<string, string>) => Promise<Done>;

const TARGETS = [
  ["windows", "windows-amd64/keeper.exe"],
  ["linux", "linux-amd64/keeper"],
];

export async function buildKeeper(root: string, go: Go) {
  const dir = join(root, "os", "keeper");
  const manifest = lf(readFileSync(join(dir, MANIFEST)));
  const tmp = mkdtempSync(join(tmpdir(), "switchboard-keeper-"));
  const files = [{ path: MANIFEST, data: manifest }];
  for (const [os, path] of TARGETS) {
    const out = join(tmp, path);
    const r = await go(["build", "-buildvcs=false", "-trimpath", "-ldflags", "-s -w -buildid=", "-o", out, "."], dir, { GOOS: os, GOARCH: "amd64", CGO_ENABLED: "0" });
    if (r.code !== 0) throw new Error(`go build ${os}/amd64: ${r.out.trim()}`);
    files.push({ path, data: readFileSync(out), mode: 0o755 } as (typeof files)[number]);
  }
  rmSync(tmp, { recursive: true });
  const tgz = pack(files);
  return { name: "keeper", version: (JSON.parse(manifest.toString("utf8")) as { version: string }).version, tgz, sha: sha256hex(tgz) };
}
