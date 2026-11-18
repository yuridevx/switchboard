// Живая проверка «установка службы машины»: node tools/fleet/live-install.mjs [флот] [устройство]
// Машина ставится так, как её ставит человек: keeper install с приглашением — служба ОС этого флота; сборку Host служба берёт из каталога сама.
// Ставит службу в ОС этого компьютера, поэтому идёт только по SB2_INSTALL=1 (раннер CI) и только на флоте в коробке.
// На Windows служба работает под текущим пользователем: его пароль — SB2_INSTALL_PASSWORD, службе он уходит строкой stdin.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fleetEnv } from "../dev.mjs";
import { killHolders } from "../box/holders.mjs";
import { fleetCall, local, newTag, root } from "./harness.mjs";

const [fleet = "box", device = "cli"] = process.argv.slice(2);
if (!local() || process.env.SB2_INSTALL !== "1") throw new Error("проверка ставит службу в ОС: только флот в коробке и SB2_INSTALL=1");
const win = process.platform === "win32";
const { call, must } = fleetCall(fleet, device);
const tag = newTag();
const machine = "svc" + tag;
const build = must("builds.list", {}).stable;
const keeper = path.join(root, "dist/builds", String(build), win ? "keeper-windows-amd64.exe" : "keeper-linux-amd64");
const home = path.join(os.homedir(), ".switchboard2", fleet);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bad = 0, total = 0;
async function step(label, fn) {
  total++;
  const t0 = Date.now();
  try {
    console.log(`✓ ${label} · ${await fn()} · ${Date.now() - t0} мс`);
  } catch (e) {
    bad++;
    console.log(`✗ ${label} · ${String(e.message).split("\n")[0]}`);
  }
}
/** keeper с аргументами и строками stdin; ответ — код выхода и вывод. */
const run = (args, lines = []) => new Promise((done) => {
  const child = spawn(keeper, args, { stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  child.on("close", (code) => done({ code, out: out.trim() }));
  child.stdin.end(lines.map((l) => l + "\n").join(""));
});

const invite = must("invite", { addr: "@" + machine });
let installed = false;
await step("keeper install принял приглашение и поставил службу ОС", async () => {
  if (win && !process.env.SB2_INSTALL_PASSWORD) throw new Error("на Windows нужен SB2_INSTALL_PASSWORD — пароль пользователя службы");
  const r = await run(["install", "--base", fleetEnv.SB2_BASE], [invite.invite, ...(win ? [process.env.SB2_INSTALL_PASSWORD] : [])]);
  installed = fs.existsSync(path.join(home, "machine.key"));
  if (r.code !== 0) throw new Error(`код ${r.code}: ${r.out.split("\n").at(-1)}`);
  return `служба switchboard2-keeper-${fleet}, папка флота ~/.switchboard2/${fleet}`;
});

await step("машина на связи: служба взяла сборку каталога и подняла Host", async () => {
  if (!installed) throw new Error("служба не поставлена");
  for (const end = Date.now() + 120_000; ; await sleep(1500)) {
    const row = must("fleet.list", {}).machines.find((m) => m.name === machine);
    const k = row?.online ? call("keeper.state", { to: `.keeper@${machine}` }).result : null;
    if (k?.host.build === build && k.host.state === "running") return `${machine}: ${row.os}, служба ${k.build}, Host ${k.host.build}`;
    if (Date.now() > end) throw new Error(`${machine}: на связи ${row?.online ?? "нет строки"}, Host ${k?.host?.build} (${k?.host?.state}${k?.host?.why ? ": " + k.host.why : ""}); ждали сборку ${build}`);
  }
});

await step("скрипт на поставленной машине выполняется", async () => {
  if (!installed) throw new Error("служба не поставлена");
  const r = must("shell.run", { to: "@" + machine, shell: "node", wait: 30, script: `console.log("sb2-" + ${JSON.stringify(tag)}, process.env.SB_MACHINE)` });
  if (r.state !== "done" || !(r.out ?? r.stdout ?? "").includes("sb2-" + tag)) throw new Error(`состояние ${r.state}, вывод: ${(r.out ?? "").slice(0, 80)}`);
  return (r.out ?? r.stdout).trim();
});

// убрать за собой: служба, её процессы, пропуск машины
if (installed) {
  const r = await run(["uninstall", "--name", fleet]);
  if (r.code !== 0) console.log(`служба не снята: ${r.out.split("\n").at(-1)}`);
  killHolders(home);
}
call("revoke", { kid: invite.kid });
console.log(bad ? `сбоев: ${bad} из ${total}` : `установка службы: ${total} из ${total}`);
process.exit(bad ? 1 : 0);
