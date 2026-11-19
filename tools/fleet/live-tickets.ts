// Живая проверка тикетов: node tools/fleet/live-tickets.ts [флот] [устройство] [машина]
// Своя сессия останавливается; тикет ей создаётся и поднимает её сам (письмо остановленной получило бы отказ); сессия сдаёт шаг
// инструментом ticket_set; история флота отдаёт движения тикета по имени строки. Ключ и модель — SB2_KEY и SB2_MODEL.
import fs from "node:fs";
import path from "node:path";
import { CallError, createApi, fleetList, httpTransport, keysModels, logQuery, message, peopleList, projectSet, sessionOpen, sessionRemove, sessionStop, ticketList, ticketNew, type SessionRow, whoami } from "@sb/protocol";
import { dev, fleetEnv } from "../dev.mjs";
import { lacks, machineTmp, newTag } from "./harness.mjs";
import { say, tool, turn as script } from "./turn.mjs";

const [fleet = "test", device = "cli", machine = "devbox"] = process.argv.slice(2);
const key = fs.readFileSync(path.join(dev, `v2-${fleet}-${device}.pass`), "utf8").trim();
const wire = httpTransport({ base: fleetEnv.SB2_BASE!, key });
const api = createApi({ ...wire, call: async (f) => { for (let i = 0; ; i++) { const r = await wire.call(f); if (r.ok || r.error !== "offline" || i >= 4) return r; await new Promise((x) => setTimeout(x, 3000)); } } });
const SEAT = process.env.SB2_KEY ?? "muse";
const DOC = { key: SEAT, model: process.env.SB2_MODEL ?? (await api.call(keysModels, { name: SEAT })).models[0]!.id };
const tag = newTag();
/** Проект проверки: один на флот, тикеты в нём копятся — номер своего тикета проверка узнаёт из ответа. */
const PROJECT = "tickets";

let bad = 0;
async function step(label: string, fn: () => Promise<string>) {
  const t0 = Date.now();
  try {
    console.log(`✓ ${label} · ${await fn()} · ${Date.now() - t0} мс`);
  } catch (e) {
    bad++;
    console.log(`✗ ${label} · ${e instanceof CallError ? `${e.word}: ${e.why ?? ""}` : (e as Error).message.split("\n")[0]}`);
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rowOf = async (cs: string): Promise<SessionRow | undefined> => ((await api.call(fleetList, { machine, full: true })).sessions as SessionRow[]).find((s) => s.callsign === cs);
async function until<T>(what: string, fn: () => Promise<T | undefined | false | null>, ms = 120_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => undefined);
    if (v) return v;
    if (Date.now() > end) throw new Error(`не дождался: ${what}`);
    await sleep(2000);
  }
}
const one = async (id: string) => (await api.call(ticketList, { ticket: id })).tickets[0]!;

let cs = "", id = "";
try {
  await step("своя сессия открыта в проекте проверки и остановлена: письмо ей — отказ", async () => {
    const me = await api.call(whoami, {});
    const projects = (await api.call(peopleList, {})).projects;
    if (!projects.some((p) => p.id === PROJECT)) await api.call(projectSet, { project: PROJECT, name: "Проверка тикетов", members: [me.person] });
    cs = (await api.call(sessionOpen, { to: "@" + machine, spec: { name: "tk-" + tag, cwd: `${machineTmp(fleet, device, machine)}/sb2-tickets-${tag}`, project: PROJECT, ...DOC } as never, mkdir: true })).callsign;
    await until(`${cs} свободна`, async () => (await rowOf(cs))?.state === "idle");
    await api.call(sessionStop, { to: cs });
    await until(`${cs} остановлена`, async () => (await rowOf(cs))?.state === "stopped", 60_000);
    const refused = await api.call(message, { to: cs, text: "проснись" }).then(() => "принято", (e: unknown) => (e as CallError).word);
    if (refused !== "stopped") throw new Error(`письмо остановленной: ${refused}`);
    return `${cs} остановлена, письмо — отказ stopped`;
  });
  await step("тикет остановленной сессии доставлен: сессия поднята и сдала шаг вердиктом", async () => {
    // в тексте тикета {id} — его номер: шаг сценария называет его инструменту
    const text = script(tool("mcp__fleet__ticket_set", { ticket: "{id}", verdict: "done", note: "живая проверка " + tag }), say("шаг сдан"));
    id = (await api.call(ticketNew, { project: PROJECT, to: cs, for: "10m", title: "Живая проверка тикета " + tag, text })).id;
    const done = await until(`тикет ${id} закрыт`, async () => { const t = await one(id); return t.state === "done" ? t : t.state === "stop" ? Promise.reject(new Error(`тикет встал: ${t.why}`)) : undefined; }, 180_000);
    const note = done.notes?.find((n) => n.verdict === "done");
    if (note?.by !== cs || !note.text.includes(tag)) throw new Error(`вердикт не от сессии: ${JSON.stringify(done.notes)}`);
    const state = (await rowOf(cs))?.state;
    if (state === "stopped") throw new Error("сессия осталась остановленной");
    return `${id}: вердикт done от ${cs}, сессия ${state}`;
  });
  if (!lacks("clickhouse"))
    await step("история флота по имени строки «ticket» отдаёт движения тикета: создан, дан, сдан", async () => {
      const want = ["new", "given", "done"];
      const kinds = await until("строки истории", async () => {
        const lines = (await api.call(logQuery, { msg: "ticket", machine, limit: 200 })).lines.filter((l) => (l.data as { ticket?: string } | undefined)?.ticket === id);
        const got = lines.map((l) => l.kind);
        return want.every((k) => got.includes(k)) ? got : undefined;
      }, 60_000);
      return `${want.length} из ${want.length}: ${[...kinds].reverse().join(" → ")}`;
    });
} finally {
  if (cs) await api.call(sessionRemove, { to: cs }).catch(() => {});
}
process.exit(bad ? 1 : 0);
