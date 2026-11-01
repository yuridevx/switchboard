// Эталоны incidents на стенде Host: настоящий HTTP на 127.0.0.1, настоящие manage, chat, questions;
// slots, profiles, watch и push — поддельные модули стенда. Номер эталона — номер теста.
import { mkdtempSync, readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stand } from "@switchboard/host";
import type { Frame, Manifest } from "@switchboard/host";
import manifest from "../module.json" with { type: "json" };
import { make, rule, wrap } from "../src/incidents.ts";
import { manage } from "../../manage/src/manage.ts";
import { make as makeChat } from "../../chat/src/chat.ts";
import { make as makeQuestions } from "../../questions/src/questions.ts";

const { FakeHolders, module, standHost, until } = stand;
type Stand = stand.Stand;
const json = (rel: string) => JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", rel, "module.json"), "utf8")) as Manifest;

const stands: Stand[] = [];
const keepers: stand.FakeHolders[] = [];
afterEach(async () => {
  for (const s of stands.splice(0)) await s.close();
  for (const k of keepers.splice(0)) await k.close();
});

const TO = "phone~you@example.com";
const PNG = { name: "screen.png", media_type: "image/png", data: "iVBORw0KGgo=" };

function freePort(): Promise<number> {
  return new Promise((ok) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => ok(p));
    });
  });
}

/** Host win: incidents с двумя типами; seen — запросы поддельных profiles, notify — поддельного push. */
async function bench(o: { home?: string; holders?: stand.FakeHolders; port?: number } = {}) {
  const port = o.port ?? (await freePort());
  const work = mkdtempSync(join(tmpdir(), "switchboard-incidents-"));
  const seen: Frame[] = [];
  const notify: Frame[] = [];
  const st = await standHost({
    machine: "win",
    home: o.home,
    holders: o.holders,
    config: { modules: { "host-incidents": { port, to: TO, types: { "disk-full": { profile: "you/profiles/disk-full", dir: work }, "build-red": { profile: "you/profiles/ci", dir: work } } } } },
    modules: [
      module("host-slots", { requests: { "session.slot": () => ({ restart: false }) } }),
      module("host-profiles", { requests: { "session.profile": (f) => (seen.push(f), { restart: false }) } }),
      module("host-watch", { requests: { "session.watchers": () => [] } }),
      module("host-push", { requests: { notify: (f) => (notify.push(f), { pushed: [] }) } }),
      { manifest: json("manage"), module: manage({ home: work }) },
      { manifest: json("chat"), module: makeChat() },
      { manifest: json("questions"), module: makeQuestions() },
      { manifest: manifest as Manifest, module: make() },
    ],
  });
  stands.push(st);
  const post = async (body: unknown, headers: Record<string, string> = {}) => {
    const r = await fetch(`http://127.0.0.1:${port}/incident`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };
  return { st, port, work, seen, notify, post };
}

describe("эталоны incidents", () => {
  it("303 · POST нового типа и ключа — сессия disk-full-1 с профилем и папкой типа; во вводе <incident> и блок вложения от человека из to; 200 new: true", async () => {
    const { st, work, seen, post } = await bench();
    const r = await post({ type: "disk-full", key: "C:", text: "Свободно 2%", attachments: [PNG] });
    expect(r).toEqual({ status: 200, body: { callsign: "disk-full-1@win", new: true } });
    expect(seen[0]).toMatchObject({ callsign: "disk-full-1@win", profile: "you/profiles/disk-full" });
    expect(st.kernel.sessions.get("disk-full-1@win")!.rec.cwd).toBe(work);
    const p = st.proc("disk-full-1@win");
    await until(() => p.inputs.length === 1);
    expect(p.inputs[0].message.content).toEqual([
      { type: "text", text: wrap("disk-full", "C:", "Свободно 2%") },
      { type: "image", source: { type: "base64", media_type: "image/png", data: PNG.data } },
    ]);
    expect(st.kernel.sessions.get("disk-full-1@win")!.rec.from).toBe(TO);
    await until(() => st.states("disk-full-1@win").at(-1)?.incident?.key === "C:");
    expect(st.states("disk-full-1@win").at(-1)!.incident).toEqual({ type: "disk-full", key: "C:" });
  });

  it("304 · POST того же ключа — та же сессия, new: false; обращение вторым вводом", async () => {
    const { st, post } = await bench();
    await post({ type: "disk-full", key: "C:", text: "Свободно 2%" });
    expect(await post({ type: "disk-full", key: "C:", text: "Свободно 1%" })).toEqual({ status: 200, body: { callsign: "disk-full-1@win", new: false } });
    expect(await post({ type: "disk-full", key: "D:", text: "Свободно 4%" })).toEqual({ status: 200, body: { callsign: "disk-full-2@win", new: true } });
    const p = st.proc("disk-full-1@win");
    await until(() => p.inputs.length === 2);
    expect(p.inputs[1].message.content).toBe(wrap("disk-full", "C:", "Свободно 1%"));
  });

  it("305 · два POST одного ключа одновременно — одна сессия, оба обращения во вводе", async () => {
    const { st, post } = await bench();
    const both = await Promise.all([post({ type: "build-red", text: "main упал" }), post({ type: "build-red", text: "и ещё раз" })]);
    expect(both.map((r) => r.body.callsign)).toEqual(["build-red-1@win", "build-red-1@win"]);
    expect(both.map((r) => r.body.new).sort()).toEqual([false, true]);
    expect([...st.kernel.sessions.keys()].filter((c) => c.startsWith("build-red"))).toEqual(["build-red-1@win"]);
    await until(() => st.proc("build-red-1@win").inputs.length === 2);
  });

  it("306 · сессия закрыта, затем POST того же ключа — новая сессия, new: true", async () => {
    const { st, post } = await bench();
    await post({ type: "disk-full", key: "C:", text: "Свободно 2%" });
    expect(await st.relay.request({ type: "session.remove", v: 1, callsign: "disk-full-1@win" })).toMatchObject({ ok: true });
    const r = await post({ type: "disk-full", key: "C:", text: "Свободно 3%" });
    expect(r).toEqual({ status: 200, body: { callsign: "disk-full-1@win", new: true } });
    const p = st.proc("disk-full-1@win");
    await until(() => p.inputs.length === 1);
    expect(p.inputs[0].message.content).toBe(wrap("disk-full", "C:", "Свободно 3%"));
  });

  it("307 · неизвестный тип, не JSON, чужой Host — 400 unknown_type и bad_frame, сессии нет; вложение без блока — 400 bad_attachment, во ввод ничего", async () => {
    const { st, port, post } = await bench();
    expect(await post({ type: "printer", text: "Замятие" })).toEqual({ status: 400, body: { error: "unknown_type" } });
    expect(await post({ type: "disk-full", text: "x" }, { "content-type": "text/plain" })).toEqual({ status: 400, body: { error: "bad_frame" } });
    expect(await post("{не json")).toEqual({ status: 400, body: { error: "bad_frame" } });
    const foreign = await new Promise<{ status: number; body: string }>((ok) => {
      const req = httpRequest({ host: "127.0.0.1", port, path: "/incident", method: "POST", headers: { host: `evil.example:${port}`, "content-type": "application/json" } }, (res) => {
        let b = "";
        res.on("data", (c) => (b += c));
        res.on("end", () => ok({ status: res.statusCode!, body: b }));
      });
      req.end(JSON.stringify({ type: "disk-full", text: "x" }));
    });
    expect(foreign).toEqual({ status: 400, body: JSON.stringify({ error: "bad_frame" }) });
    expect(st.kernel.sessions.size).toBe(0);
    const zip = await post({ type: "disk-full", key: "C:", text: "дамп", attachments: [{ name: "dump.zip", media_type: "application/zip", data: "UEsDBA==" }] });
    expect(zip).toEqual({ status: 400, body: { error: "bad_attachment" } });
    await new Promise((r) => setTimeout(r, 20));
    expect(st.proc("disk-full-1@win").inputs).toHaveLength(0);
  });

  it("308 · AskUserQuestion в сессии инцидента — вопрос человеку из to: кадр question и пуш", async () => {
    const { st, notify, post } = await bench();
    await post({ type: "disk-full", key: "C:", text: "Свободно 2%" });
    const p = st.proc("disk-full-1@win");
    await until(() => p.inputs.length === 1);
    void p.ask("AskUserQuestion", { questions: [{ question: "Удалить старые логи?", options: [{ label: "Да" }, { label: "Нет" }] }] }, "toolu_01Df");
    const q = await until(() => st.relay.frames("question")[0]);
    expect(q).toMatchObject({ type: "question", from: "disk-full-1@win", to: [TO], question: "toolu_01Df" });
    await until(() => notify.length === 1);
    expect(notify[0]).toMatchObject({ clients: [TO] });
  });

  it("309 · плейбук типа: сессия с профилем своего типа; правило модуля в системном промпте", async () => {
    const { st, seen, post } = await bench();
    await post({ type: "build-red", text: "main упал на тесте auth" });
    expect(seen.map((f) => [f.callsign, f.profile])).toEqual([["build-red-1@win", "you/profiles/ci"]]);
    const append = (st.query("build-red-1@win").options as { systemPrompt: { append?: string } }).systemPrompt.append ?? "";
    expect(append).toContain(rule("build-red", undefined, TO));
  });

  it("310 · перезапуск Host при живой сессии инцидента — POST того же ключа в неё же; вопрос — человеку из to; HTTP закрыт штатно", async () => {
    const k = new FakeHolders();
    keepers.push(k);
    const a = await bench({ holders: k });
    await a.post({ type: "disk-full", key: "C:", text: "Свободно 2%" });
    await a.st.close();
    stands.splice(stands.indexOf(a.st), 1);
    await expect(fetch(`http://127.0.0.1:${a.port}/incident`, { method: "POST" })).rejects.toThrow();
    const b = await bench({ holders: k, home: a.st.home, port: a.port });
    await until(() => b.st.kernel.sessions.get("disk-full-1@win")?.state === "idle");
    expect(b.st.kernel.sessions.get("disk-full-1@win")!.rec.from).toBe(TO);
    expect(await b.post({ type: "disk-full", key: "C:", text: "Свободно 1%" })).toEqual({ status: 200, body: { callsign: "disk-full-1@win", new: false } });
    void k.procs.get("disk-full-1@win")!.ask("AskUserQuestion", { questions: [{ question: "Чистить?" }] }, "toolu_02Df");
    expect(await until(() => b.st.relay.frames("question")[0])).toMatchObject({ to: [TO] });
  });
});
