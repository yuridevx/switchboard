// Живой сценарий выпусков: каталог и планы у «выпусков», keeper каждой машины отвечает сам; тестовое приложение —
// загрузка по ссылкам, выкладка в план машины, смена версии, два падения → failed, выключение силой, удаление.
// env: FLOW_CLIENT_KEY, FLOW_MACHINE (машина для тестового приложения).
import { link } from "@switchboard/relay";
import { pack, sha256hex, shaLine } from "@switchboard/release";

const url = process.env.SWITCHBOARD_URL ?? "wss://switchboard.yuridevx1608.workers.dev";
const M = process.env.FLOW_MACHINE!;
const l = link({ url, key: process.env.FLOW_CLIENT_KEY! });
const fails: string[] = [];
const check = (n: string, ok: boolean, d?: unknown) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${n}${d === undefined ? "" : " · " + JSON.stringify(d).slice(0, 300)}`);
  if (!ok) fails.push(n);
};
const req = async (f: Record<string, unknown>) => (await l.request({ v: 1, ...f } as never)) as { ok: boolean; result?: any; error?: string };
const rel = (type: string, f: Record<string, unknown> = {}) => req({ type: `releases.${type}`, to: ".releases", ...f });
const state = async (m: string) => (await req({ type: "keeper.state", to: `.keeper@${m}` })).result as { keeper: string; rev: number; parts: Array<{ part: string; version?: string; state: string; restarts: number; error?: string }> } | undefined;
const partOn = async (m: string, p: string) => (await state(m))?.parts.find((x) => x.part === p);
const wait = async (ok: () => Promise<boolean>, ms: number) => {
  for (const t0 = Date.now(); !(await ok()); ) {
    if (Date.now() - t0 > ms) return false;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return true;
};

/** Приложение: живёт, пока открыт ввод; crash — выходит само с кодом 3. */
function app(crash: boolean): Buffer {
  const main = crash
    ? `console.error("падаю нарочно"); process.exit(3);`
    : `const fs = require("node:fs"), path = require("node:path");
const file = path.join(process.env.SWITCHBOARD_DATA, "count");
const n = Number(fs.existsSync(file) ? fs.readFileSync(file, "utf8") : 0) + 1;
fs.writeFileSync(file, String(n));
console.log("старт " + n);
process.stdin.resume();
process.stdin.on("end", () => process.exit(0));`;
  return pack([
    { path: "app.json", data: Buffer.from(JSON.stringify({ run: ["node", "main.cjs"] })) },
    { path: "main.cjs", data: Buffer.from(main) },
  ]);
}

async function upload(part: string, version: string, tgz: Buffer) {
  const r = await rel("upload", { part, version });
  if (!r.ok) return r;
  const sha = sha256hex(tgz);
  for (const [to, body] of [
    [r.result.tgz, tgz],
    [r.result.sha256, Buffer.from(shaLine(sha, version))],
  ] as const) {
    const put = await fetch(to, { method: "PUT", body: new Uint8Array(body) });
    if (!put.ok) return { ok: false, error: `PUT ${put.status}` };
  }
  return { ok: true, result: { sha } };
}

try {
  if (!(await wait(async () => l.state === "open", 15000))) throw new Error("нет связи с relay");

  // --- каталог и машины ---
  const list = await rel("list");
  check("releases.list: host и keeper со stable", list.ok && !!list.result.parts.host?.stable && !!list.result.parts.keeper?.stable, list.ok ? list.result.parts : list.error);
  for (const m of l.roster?.machines ?? []) {
    const s = await state(m.machine);
    const host = s?.parts.find((p) => p.part === "host");
    const want = list.result?.machines.find((x: any) => x.machine === m.machine)?.plan.host?.pin ?? list.result?.parts.host?.stable;
    check(`keeper.state ${m.machine}: keeper ${s?.keeper}, host ${host?.version} ${host?.state}`, host?.state === "running" && host.version === want, s ?? "нет ответа");
  }

  // --- тестовое приложение ---
  const P = "sbprobe";
  const n = Math.floor(Date.now() / 60000) % 100000;
  const v1 = `0.1.${n * 2}`;
  const v2 = `0.1.${n * 2 + 1}`;
  check(`upload ${P} ${v1}`, (await upload(P, v1, app(false))).ok);
  const again = await rel("upload", { part: P, version: v1 });
  check("та же версия второй раз — version_exists", !again.ok && again.error === "version_exists", again.error);
  check(`upload ${P} ${v2} (падает)`, (await upload(P, v2, app(true))).ok);

  const s1 = await rel("set", { machine: M, part: P, pin: v1, on: true });
  check(`set ${M} ${P} pin ${v1}`, s1.ok, s1.error ?? s1.result);
  check(`${P} ${v1} работает на ${M}`, await wait(async () => (await partOn(M, P))?.state === "running" && (await partOn(M, P))?.version === v1, 120000), await partOn(M, P));

  await rel("set", { machine: M, part: P, pin: v2 });
  check(`${P} ${v2}: два падения — failed`, await wait(async () => (await partOn(M, P))?.state === "failed", 120000), await partOn(M, P));

  await rel("set", { machine: M, part: P, pin: v1 });
  check(`откат ${P} на ${v1} — снова работает`, await wait(async () => (await partOn(M, P))?.state === "running" && (await partOn(M, P))?.version === v1, 120000), await partOn(M, P));

  await rel("set", { machine: M, part: P, on: false, force: true });
  check(`set on: false, force — ${P} остановлен`, await wait(async () => (await partOn(M, P))?.state === "stopped", 60000), await partOn(M, P));

  const rm = await rel("set", { machine: M, part: P, remove: true });
  check(`set remove — ${P} ушёл из плана и keeper.state`, rm.ok && (await wait(async () => !(await partOn(M, P)), 60000)), rm.error ?? (await partOn(M, P)));
  const rm2 = await rel("set", { machine: M, part: P, remove: true });
  check("remove второй раз — no_part", !rm2.ok && rm2.error === "no_part", rm2.error);
} catch (e) {
  check("сценарий", false, (e as Error).message);
} finally {
  l.close(1000, "done");
}
console.log(fails.length ? `releases: FAIL · ${fails.length}` : "releases: ok");
process.exitCode = fails.length ? 1 : 0;
