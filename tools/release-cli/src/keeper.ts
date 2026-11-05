// Архив keeper: сборки по ОС без сведений git: один код — один хэш на любой машине.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MANIFEST, pack, sha256hex } from "@switchboard/release";
import { ROOT } from "./module.ts";
import type { Ran } from "./spawn.ts";

export type Go = (args: string[], cwd: string, env: Record<string, string>) => Promise<Ran>;

const TARGETS = [
  { goos: "windows", goarch: "amd64", file: "keeper.exe" },
  { goos: "linux", goarch: "amd64", file: "keeper" },
];

export async function buildKeeper(go: Go): Promise<{ name: string; version: string; tgz: Buffer; sha: string }> {
  const source = join(ROOT, "os/keeper");
  const manifest = readFileSync(join(source, MANIFEST));
  const { version } = JSON.parse(manifest.toString("utf8")) as { version: string };
  const out = mkdtempSync(join(tmpdir(), "switchboard-keeper-"));
  try {
    const files = [{ path: MANIFEST, data: manifest as Uint8Array, mode: 0o644 }];
    for (const { goos, goarch, file } of TARGETS) {
      const target = join(out, `${goos}-${goarch}`, file);
      const r = await go(["build", "-buildvcs=false", "-trimpath", "-ldflags", "-s -w -buildid=", "-o", target, "."], source, { GOOS: goos, GOARCH: goarch, CGO_ENABLED: "0" });
      if (r.code !== 0) throw new Error(`go build ${goos}/${goarch}: ${r.out.trim()}`);
      files.push({ path: `${goos}-${goarch}/${file}`, data: readFileSync(target), mode: 0o755 });
    }
    const tgz = pack(files);
    return { name: "keeper", version, tgz, sha: sha256hex(tgz) };
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}
