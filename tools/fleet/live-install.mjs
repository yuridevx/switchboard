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
import { check, local, root } from "./harness.mjs";

await check(async (t) => {
  if (!local() || process.env.SB2_INSTALL !== "1") throw new Error("проверка ставит службу в ОС: только флот в коробке и SB2_INSTALL=1");
  const win = process.platform === "win32";
  const machine = "svc" + t.tag;
  const build = (await t.must("builds.list", {})).stable;
  const keeper = path.join(root, "dist/builds", String(build), win ? "keeper-windows-amd64.exe" : "keeper-linux-amd64");
  const home = path.join(os.homedir(), ".switchboard2", t.fleet);
  /** keeper с аргументами и строками stdin; ответ — код выхода и вывод. Ждём выхода самого процесса. */
  const run = (args, lines = []) => new Promise((done, fail) => {
    const child = spawn(keeper, args, { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("error", fail);
    child.on("close", (code) => done({ code, out: out.trim() }));
    child.stdin.end(lines.map((l) => l + "\n").join(""));
  });

  const invite = await t.must("invite", { addr: "@" + machine });
  // убрать за собой при любом исходе, по порядку: служба ОС и её процессы, затем пропуск машины — с ним флот убирает и строку машины
  t.defer(`служба и машина ${machine}`, async (go) => {
    if (fs.existsSync(path.join(home, "machine.key"))) {
      const r = await run(["uninstall", "--name", t.fleet]);
      killHolders(home);
      if (r.code !== 0) throw new Error(`служба не снята: ${r.out.split("\n").at(-1)}`);
    }
    return go("revoke", { kid: invite.kid });
  });

  await t.step("keeper install принял приглашение и поставил службу ОС", async () => {
    if (win && !process.env.SB2_INSTALL_PASSWORD) throw new Error("на Windows нужен SB2_INSTALL_PASSWORD — пароль пользователя службы");
    const r = await run(["install", "--base", fleetEnv.SB2_BASE], [invite.invite, ...(win ? [process.env.SB2_INSTALL_PASSWORD] : [])]);
    if (r.code !== 0) throw new Error(`код ${r.code}: ${r.out.split("\n").at(-1)}`);
    return `служба switchboard2-keeper-${t.fleet}, папка флота ~/.switchboard2/${t.fleet}`;
  });

  await t.step("машина на связи: служба взяла сборку каталога и подняла Host", async () => {
    let last = "строки машины нет";
    const seen = await t.wait(`${machine}: на связи, Host сборки ${build} запущен`, async () => {
      const row = (await t.must("fleet.list", {})).machines.find((m) => m.name === machine);
      // машина ещё не на связи — службу не спрашиваем; пока Host не поднят, запрос к службе отказывает: это «ещё нет», а не сбой
      const r = row?.online ? await t.call("keeper.state", { to: `.keeper@${machine}` }) : null;
      const k = r?.ok ? r.result : null;
      last = `на связи ${row?.online ?? "нет строки"}, Host ${k?.host?.build} (${k?.host?.state}${k?.host?.why ? ": " + k.host.why : ""})${r && !r.ok ? `, служба: ${r.error}` : ""}`;
      return k?.host.build === build && k.host.state === "running" && { row, k };
    }, () => last);
    return `${machine}: ${seen.row.os}, служба ${seen.k.build}, Host ${seen.k.host.build}`;
  });

  await t.step("скрипт на поставленной машине выполняется", async () => {
    const out = await t.node(machine, `console.log("sb2-" + ${JSON.stringify(t.tag)}, process.env.SB_MACHINE)`);
    if (!out.includes("sb2-" + t.tag)) throw new Error(`вывод: ${out.slice(0, 80)}`);
    return out.trim();
  });
});
