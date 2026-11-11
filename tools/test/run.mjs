// Прогон тестов v2 по пакетам с пределом на пакет: node tools/test/run.mjs [часть имени пакета]
// Снимает всё дерево процессов пакета по пределу: на Windows `timeout` снимает только обёртку.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fs.realpathSync.native(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."));
const LIMIT_MS = 6 * 60_000;
const only = process.argv[2];
const packages = ["protocol", "platform", "services", "host", "web"].filter((p) => fs.existsSync(path.join(root, p, "package.json")) && (!only || p.includes(only)));

function run(cmd, args, cwd) {
  return new Promise((res) => {
    const t0 = Date.now();
    const child = spawn(cmd, args, { cwd, shell: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const timer = setTimeout(() => {
      if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"]);
      else child.kill("SIGKILL");
      out += "\nпредел пакета вышел";
    }, LIMIT_MS);
    child.on("close", (code) => (clearTimeout(timer), res({ code, out, ms: Date.now() - t0 })));
  });
}

let failed = 0;
for (const p of packages) {
  const has = JSON.parse(fs.readFileSync(path.join(root, p, "package.json"), "utf8")).scripts?.test;
  if (!has) continue;
  // типы пакета — вместе с тестами: ошибка типов в тесте не должна дожидаться CI
  const types = await run("npx", ["tsc", "--noEmit"], path.join(root, p));
  if (types.code !== 0) {
    failed++;
    console.log(`✗ ${p} · типы`);
    console.log(types.out.split("\n").slice(0, 30).join("\n"));
    continue;
  }
  const r = await run("npm", ["test", "--silent"], path.join(root, p));
  const tests = /Tests\s+(.*)/.exec(r.out)?.[1] ?? "";
  console.log(`${r.code === 0 ? "✓" : "✗"} ${p} · ${(r.ms / 1000).toFixed(1)} с · ${tests}`);
  if (r.code !== 0) {
    failed++;
    console.log(r.out.split("\n").slice(-40).join("\n"));
  }
}
if (fs.existsSync(path.join(root, "keeper", "go.mod"))) {
  const r = await run("go", ["test", "./..."], path.join(root, "keeper"));
  console.log(`${r.code === 0 ? "✓" : "✗"} keeper · ${(r.ms / 1000).toFixed(1)} с`);
  if (r.code !== 0) {
    failed++;
    console.log(r.out.split("\n").slice(-40).join("\n"));
  }
}
process.exit(failed ? 1 : 0);
