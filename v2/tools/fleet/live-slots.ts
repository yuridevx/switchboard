// Живая проверка «Два запаса недели»: node tools/fleet/live-slots.ts <флот> <устройство> <машина>
// На машине с входом Claude: числа аккаунта сходятся с ответом Claude, у очереди два места, сессии Fable и Opus идут в одной очереди,
// смена модели переводит сессию на другое место. Сессии открываются без сообщения: модель у Claude не вызывается.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { httpTransport, newId } from "@sb/protocol";
import { fleetEnv } from "../dev.mjs";

const [fleet, device, machine] = process.argv.slice(2);
if (!fleet || !device || !machine) throw new Error("нужно: <флот> <устройство> <машина>");
const key = fs.readFileSync(path.join(os.homedir(), ".switchboard-dev", `v2-${fleet}-${device}.pass`), "utf8").trim();
const link = httpTransport({ base: fleetEnv.SB2_BASE!, key });
const call = (type: string, fields: Record<string, unknown> = {}) => link.call({ ...fields, type, id: newId("r"), trace: newId("t") }) as Promise<{ ok: boolean; result?: any; error?: string; why?: string }>;
const to = "@" + machine;
const tag = newId("s").slice(-4);
let bad = 0;
const step = (label: string, ok: boolean, more = "") => { if (!ok) bad++; console.log(`${ok ? "✓" : "✗"} ${label}${more ? " · " + more : ""}`); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Модель, на которой идёт процесс сессии: строка Model её статуса у Claude. */
async function modelOf(callsign: string, want?: RegExp): Promise<string> {
  let seen = "";
  for (let i = 0; i < 20; i++) {
    const r = await call("session.call", { to: callsign, method: "status" });
    const row = (r.result?.sections ?? []).flatMap((x: any) => x.rows ?? []).find((x: any) => x.label === "Model");
    if (row?.value) seen = String(row.value);
    if (seen && (!want || want.test(seen))) return seen;
    await sleep(1500);
  }
  return seen;
}
const rowOf = async (callsign: string) => ((await call("fleet.list", {})).result?.sessions ?? []).find((s: any) => s.callsign === callsign);

/** Сырой ответ Claude о лимитах аккаунта — тем же вызовом, что опрос службы, скриптом на самой машине. */
const RAW = `
const fs = await import("node:fs"), path = await import("node:path"), os = await import("node:os"), { pathToFileURL } = await import("node:url");
const home = path.join(os.homedir(), ".switchboard2", ${JSON.stringify(fleet)}, "host");
const build = fs.readdirSync(home).filter((n) => /^\\d+$/.test(n)).sort((a, b) => b - a)[0];
const sdk = path.join(home, build, "node_modules", "@anthropic-ai", "claude-agent-sdk");
const pkg = JSON.parse(fs.readFileSync(path.join(sdk, "package.json"), "utf8"));
const { query } = await import(pathToFileURL(path.join(sdk, pkg.exports?.["."]?.import ?? pkg.exports?.["."]?.default ?? pkg.main ?? "sdk.mjs")).href);
const dir = path.join(home, "data", "accounts", process.argv[2] ?? fs.readFileSync(0, "utf8").trim());
let finish; const closed = new Promise((r) => (finish = r));
const q = query({ prompt: (async function* () { await closed; })(), options: { env: { ...process.env, CLAUDE_CONFIG_DIR: dir, CLAUDE_SECURESTORAGE_CONFIG_DIR: dir, DISABLE_UPDATES: "1" }, permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true } });
const u = await Promise.race([q["usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET"]({ skipBehaviors: true }), new Promise((_, no) => setTimeout(() => no(new Error("timeout")), 25000))]);
const r = u.rate_limits ?? {};
console.log("RAW " + JSON.stringify({ week: r.seven_day?.utilization ?? null, fable: (r.model_scoped ?? []).find((m) => /fable/i.test(m.display_name ?? ""))?.utilization ?? null, shares: r.weekly_scoped_shares ?? null }));
finish(); q.close(); process.exit(0);
`;

const list = (await call("account.list", { to })).result;
const queue = list.slots.find((q: any) => q.lanes?.fable?.account && q.lanes?.other?.account);
if (!queue) throw new Error(`на ${machine} нет очереди с аккаунтом на обоих местах`);
const opened: string[] = [];
try {
  step("у очереди два места и нет вида", !("model" in queue) && !!queue.lanes.fable.account && !!queue.lanes.other.account, `Fable — ${queue.lanes.fable.account}, остальные — ${queue.lanes.other.account}`);

  const mail = queue.lanes.fable.account as string;
  const raw = await call("shell.run", { to, script: RAW, shell: "node", stdin: mail, wait: 60, timeout: 70 });
  const line = String(raw.result?.out ?? "").split("\n").find((l) => l.startsWith("RAW "));
  const claude = line ? JSON.parse(line.slice(4)) : null;
  const ours = ((await call("account.list", { to })).result.accounts.find((a: any) => a.id === mail)?.limits ?? []) as Array<{ name: string; used: number; fable?: number; hold?: number }>;
  const pct = (name: string) => { const l = ours.find((x) => x.name === name); return l ? Math.round(l.used * 100) : null; };
  // ответ Claude без недели (расхода ещё не было) чисел не даёт — тогда и у флота их нет
  const diff = claude ? Math.max(Math.abs((claude.week ?? 0) - (pct("seven_day") ?? 0)), Math.abs((claude.fable ?? Math.round(((claude.shares?.[0]?.used_percent_of_weekly ?? 0) / (claude.shares?.[0]?.allowance_percent_of_weekly ?? 50)) * 100)) - (pct("fable") ?? 0))) : NaN;
  step("неделя и Fable флота сходятся с ответом Claude", diff <= 1, `Claude: неделя ${claude?.week}, Fable ${claude?.fable}; флот: неделя ${pct("seven_day")}, Fable ${pct("fable")}; расхождение ${diff} п. п.; доля в ответе: ${JSON.stringify(claude?.shares)}`);

  const a = await call("session.open", { to, spec: { name: "live-fable-" + tag, cwd: "~", slot: queue.name } });
  if (a.ok) opened.push(a.result.callsign);
  const b = await call("session.open", { to, spec: { name: "live-opus-" + tag, cwd: "~", slot: queue.name, model: "claude-opus-5-5" } });
  if (b.ok) opened.push(b.result.callsign);
  step("сессия без модели и сессия на Opus открыты в одной очереди", a.ok && b.ok, [a.why, b.why].filter(Boolean).join("; "));
  const ma = a.ok ? await modelOf(a.result.callsign) : "", mb = b.ok ? await modelOf(b.result.callsign) : "";
  step("без модели — Fable; названная — Opus", /fable/i.test(ma) && /opus/i.test(mb), `${ma} · ${mb}`);
  const now = (await call("account.list", { to })).result.slots.find((q: any) => q.name === queue.name);
  const ra = a.ok ? await rowOf(a.result.callsign) : null, rb = b.ok ? await rowOf(b.result.callsign) : null;
  step("сессии идут на аккаунтах своих мест", ra?.account === now.lanes.fable.account && rb?.account === now.lanes.other.account, `Fable — ${ra?.account}, Opus — ${rb?.account}`);

  const moved = a.ok ? await call("session.update", { to: a.result.callsign, patch: { model: "claude-opus-5-5" } }) : { ok: false, why: "сессии нет" };
  const after = moved.ok ? await modelOf(a.result.callsign, /opus/i) : "";
  step("смена модели на Opus — сессия идёт на месте остальных", moved.ok && /opus/i.test(after), after || moved.why || "");

  const noLane = await call("slot.swap", { to, slot: queue.name });
  step("«сменить сейчас» без места не принимается", !noLane.ok, noLane.error ?? "");
} finally {
  for (const c of opened) await call("session.remove", { to: c });
}
console.log(`${bad ? "есть сбои: " + bad : "всё прошло"}`);
process.exit(bad ? 1 : 0);
