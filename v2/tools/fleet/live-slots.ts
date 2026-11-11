// Живая проверка «очередь диктует модель»: node tools/fleet/live-slots.ts <флот> <устройство> <машина>
// На машине с входом Claude: заводит очередь остальных моделей, проверяет отказ на Fable в ней, модель сессии без своей модели в обеих очередях, убирает за собой.
// Сессии открываются без сообщения: модель у Claude не вызывается.
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
const REST = "live-rest-" + tag;
let bad = 0;
const step = (label: string, ok: boolean, more = "") => { if (!ok) bad++; console.log(`${ok ? "✓" : "✗"} ${label}${more ? " · " + more : ""}`); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Модель, на которой идёт процесс сессии: строка Model её статуса у Claude. */
async function modelOf(callsign: string): Promise<string> {
  for (let i = 0; i < 20; i++) {
    const r = await call("session.call", { to: callsign, method: "status" });
    const row = (r.result?.sections ?? []).flatMap((x: any) => x.rows ?? []).find((x: any) => x.label === "Model");
    if (row?.value) return String(row.value);
    await sleep(1500);
  }
  return "";
}

const list = (await call("account.list", { to })).result;
const fable = list.slots.find((q: any) => q.model === "fable" && q.account);
if (!fable) throw new Error(`на ${machine} нет очереди fable с аккаунтом`);
const opened: string[] = [];
try {
  step("очередь остальных моделей заведена", (await call("slot.set", { to, slot: REST, model: "other", order: [fable.account] })).ok);
  const slots = (await call("account.list", { to })).result.slots;
  step("account.list отдаёт вид очередей", slots.find((q: any) => q.name === REST)?.model === "other" && slots.find((q: any) => q.name === fable.name)?.model === "fable");
  const refused = await call("session.open", { to, spec: { name: "live-no-" + tag, cwd: "~", slot: REST, model: "claude-fable-5-2" } });
  step("Fable в очереди остальных — отказ model_not_in_slot", !refused.ok && refused.error === "model_not_in_slot", refused.why ?? "");
  const refused2 = await call("session.open", { to, spec: { name: "live-no2-" + tag, cwd: "~", slot: fable.name, model: "claude-opus-5-5" } });
  step("Opus в очереди fable — отказ model_not_in_slot", !refused2.ok && refused2.error === "model_not_in_slot", refused2.why ?? "");
  const a = await call("session.open", { to, spec: { name: "live-rest-" + tag, cwd: "~", slot: REST } });
  if (a.ok) opened.push(a.result.callsign);
  const ma = a.ok ? await modelOf(a.result.callsign) : "";
  step("сессия без модели в очереди остальных идёт на Opus", /opus/i.test(ma), ma || a.why || "");
  const b = await call("session.open", { to, spec: { name: "live-fable-" + tag, cwd: "~", slot: fable.name } });
  if (b.ok) opened.push(b.result.callsign);
  const mb = b.ok ? await modelOf(b.result.callsign) : "";
  step("сессия без модели в очереди fable идёт на Fable", /fable/i.test(mb), mb || b.why || "");
  const moved = a.ok ? await call("session.update", { to: a.result.callsign, patch: { slot: fable.name, model: "claude-fable-5-2" } }) : { ok: false, why: "сессии нет" };
  step("очередь и модель одним запросом — сессия переходит в очередь fable", moved.ok, moved.why ?? "");
} finally {
  for (const c of opened) await call("session.remove", { to: c });
  const gone = await call("slot.set", { to, slot: REST, order: [] });
  step("очередь убрана, сессии закрыты", gone.ok, gone.why ?? "");
}
console.log(`${bad ? "есть сбои: " + bad : "всё прошло"}`);
process.exit(bad ? 1 : 0);
