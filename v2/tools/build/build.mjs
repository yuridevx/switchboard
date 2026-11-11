// Сборка v2 под одним номером: архив Host и файлы Keeper. node tools/build/build.mjs <номер> [--upload <флот> [устройство]]
// Архив Host: src/main.ts (весь код Host одним файлом, кроме SDK), package.json и package-lock.json — Keeper на машине делает npm ci.
// --upload: загрузить в каталог флота запросом builds.upload пропуском ~/.switchboard-dev/v2-<флот>-<устройство>.pass.
import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { digest, hostBundle } from "./digest.mjs";
import { fleetEnv } from "../dev.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(path.join(root, "package.json"));
const build = Number(process.argv[2]);
if (!Number.isInteger(build) || build < 1) throw new Error("нужен номер сборки: целое от 1");
const out = path.join(root, "dist", "builds", String(build));
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

/* Host */
const esbuild = require("esbuild");
const stage = path.join(out, "host");
fs.mkdirSync(path.join(stage, "src"), { recursive: true });
await esbuild.build({
  ...hostBundle(root),
  outfile: path.join(stage, "src/main.ts"),
  banner: { js: "// Host Switchboard v2, сборка " + build + ". Собранный файл: правки — в исходниках v2/host." },
});
const hostPkg = JSON.parse(fs.readFileSync(path.join(root, "host/package.json"), "utf8"));
fs.writeFileSync(path.join(stage, "package.json"), JSON.stringify({ name: "sb-host", version: "0.0." + build, private: true, type: "module", dependencies: { "@anthropic-ai/claude-agent-sdk": hostPkg.dependencies["@anthropic-ai/claude-agent-sdk"] } }, null, 2) + "\n");
const lock = spawnSync("npm", ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: stage, shell: true, stdio: "pipe" });
if (lock.status !== 0) throw new Error("package-lock не собран: " + lock.stderr);
execFileSync(process.platform === "win32" ? path.join(process.env.SystemRoot ?? "C:/Windows", "System32", "tar.exe") : "tar", ["-czf", path.join(out, "host.tgz"), "-C", stage, "src", "package.json", "package-lock.json"]);
fs.rmSync(stage, { recursive: true, force: true });

/* Keeper */
for (const [goos, goarch, name] of [["windows", "amd64", "keeper-windows-amd64.exe"], ["linux", "amd64", "keeper-linux-amd64"]]) {
  const r = spawnSync("go", ["build", "-trimpath", "-ldflags", `-s -w -X main.build=${build}`, "-o", path.join(out, name), "."], { cwd: path.join(root, "keeper"), env: { ...process.env, GOOS: goos, GOARCH: goarch, CGO_ENABLED: "0" }, stdio: "pipe" });
  if (r.status !== 0) throw new Error(`keeper ${goos} не собран: ${r.stderr}`);
}

const files = fs.readdirSync(out).map((name) => {
  const body = fs.readFileSync(path.join(out, name));
  return { name, sha256: crypto.createHash("sha256").update(body).digest("hex"), size: body.length };
});
for (const f of files) console.log(`${f.name} · ${(f.size / 1024).toFixed(0)} КБ · ${f.sha256.slice(0, 12)}`);

const up = process.argv.indexOf("--upload");
if (up > 0) {
  const fleet = process.argv[up + 1], device = process.argv[up + 2] ?? "cli";
  const dir = path.join(os.homedir(), ".switchboard-dev");
  const env = fleetEnv;
  const key = fs.readFileSync(path.join(dir, `v2-${fleet}-${device}.pass`), "utf8").trim();
  let commit;
  try {
    commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root }).toString().trim();
  } catch {}
  const res = await fetch(env.SB2_BASE + "/call", { method: "POST", headers: { authorization: "Bearer " + key, "content-type": "application/json" }, body: JSON.stringify({ type: "builds.upload", id: "b" + build, build, commit, digest: await digest(root), files }) });
  const reply = await res.json();
  if (!reply.ok) throw new Error("builds.upload: " + reply.error + " " + (reply.why ?? ""));
  for (const f of files) {
    const put = await fetch(reply.result.links[f.name], { method: "PUT", body: fs.readFileSync(path.join(out, f.name)) });
    if (!put.ok) throw new Error(`загрузка ${f.name}: HTTP ${put.status}`);
  }
  console.log(`сборка ${build} загружена во флот ${fleet}`);
}
