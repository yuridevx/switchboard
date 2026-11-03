// Эталоны и стыки модуля chat на стенде Host: поддельные SDK, relay, keeper и часы.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { content, stand } from "@switchboard/host";
import type { Manifest } from "@switchboard/host";
import manifest from "../module.json" with { type: "json" };
import { make } from "../src/chat.ts";

const { standHost, turn, until } = stand;
type Stand = stand.Stand;

let st: Stand | null = null;
afterEach(async () => {
  await st?.close();
  st = null;
});

async function bench() {
  st = await standHost({ modules: [{ manifest: manifest as Manifest, module: make() }] });
  return st;
}

const b64 = (s: string) => Buffer.from(s).toString("base64");

/** Папка сессии с файлами; git — репозиторий с .gitignore. */
function folder(git: boolean): string {
  const d = mkdtempSync(join(tmpdir(), "switchboard-chat-"));
  for (const f of ["src/worker.ts", "test/worker.test.ts", "build/worker.js", "README.md"]) {
    mkdirSync(join(d, f, ".."), { recursive: true });
    writeFileSync(join(d, f), "//");
  }
  if (git) {
    writeFileSync(join(d, ".gitignore"), "build/\n");
    execFileSync("git", ["init", "-q"], { cwd: d });
  }
  return d;
}

/** Функции SDK чтения разговора: файл есть, записи — без границ сжатия. */
const conversation = (getSessionMessages: (...a: unknown[]) => Promise<unknown>) => ({ getSessionInfo: async () => ({}), importSessionToStore: async () => {}, getSessionMessages });

describe("эталоны chat", () => {
  it("15 · session.prompt простаивающей сессии: ввод человека без обёртки, ход, reply ok; session.history отдаёт это сообщение", async () => {
    const s = await bench();
    const sess = await s.open("site@laptop");
    const r = await s.relay.request({ type: "session.prompt", v: 1, callsign: "site@laptop", uuid: "9c4d", text: "Почини сборку" });
    expect(r).toMatchObject({ ok: true, result: { uuid: "9c4d" } });
    const p = s.proc("site@laptop");
    await until(() => p.inputs.length === 1);
    expect(p.inputs[0]).toMatchObject({ type: "user", priority: "next", uuid: "9c4d", origin: { kind: "human" }, message: { role: "user", content: "Почини сборку" } });
    expect(sess.info.from).toBe("panel-desk~owner@example.com");
    turn(p, "Смотрю, что падает.");
    await until(() => sess.state === "idle" && s.states("site@laptop").some((f) => f.state === "busy"));

    const rec = [
      { type: "user", uuid: "9c4d", session_id: sess.info.session_id, message: { role: "user", content: "Почини сборку" }, parent_tool_use_id: null, parent_agent_id: null },
      { type: "assistant", uuid: "a1", session_id: sess.info.session_id, message: {}, parent_tool_use_id: null, parent_agent_id: null },
    ];
    const calls: unknown[][] = [];
    s.sdk.functions = conversation(async (...a: unknown[]) => (calls.push(a), rec));
    const h = await s.relay.request({ type: "session.history", v: 1, callsign: "site@laptop", before: null, limit: 50 });
    expect(h).toMatchObject({ ok: true, result: { messages: rec, more: false } });
    expect(calls).toMatchObject([[sess.info.session_id, { dir: sess.info.cwd, includeSystemMessages: true }]]);
    expect(p.inputs).toHaveLength(1);
  });

  it("82 · вложения: text, image, document по порядку одним сообщением; build.zip — bad_attachment, во ввод ничего, тип в журнале", async () => {
    const s = await bench();
    await s.open("site@laptop");
    const ok = await s.relay.request({
      type: "session.prompt",
      v: 1,
      callsign: "site@laptop",
      text: "Что на скрине?",
      attachments: [
        { name: "screen.png", media_type: "image/png", data: "iVBOR" },
        { name: "spec.pdf", media_type: "application/pdf", data: "JVBER" },
      ],
    });
    expect(ok).toMatchObject({ ok: true });
    const p = s.proc("site@laptop");
    await until(() => p.inputs.length === 1);
    expect(p.inputs[0].message.content).toEqual([
      { type: "text", text: "Что на скрине?" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBOR" } },
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: "JVBER" } },
    ]);
    const bad = await s.relay.request({ type: "session.prompt", v: 1, callsign: "site@laptop", text: "и это", attachments: [{ name: "build.zip", media_type: "application/zip", data: "UEsDB" }] });
    expect(bad).toMatchObject({ ok: false, error: "bad_attachment" });
    await new Promise((r) => setTimeout(r, 30));
    expect(p.inputs).toHaveLength(1);
    const line = s.journal().find((l) => l.word === "bad_attachment");
    expect(line).toMatchObject({ kind: "refuse", who: "host-chat" });
    expect(line!.why).toContain("application/zip");
  });

  it("83 · session.files «worker» — пути от папки сессии без скрытого .gitignore; prompt с @src/worker.ts — без client_composed", async () => {
    const s = await bench();
    const cwd = folder(true);
    await s.open("site@laptop", { cwd });
    const f = await s.relay.request({ type: "session.files", v: 1, callsign: "site@laptop", query: "worker", limit: 20 });
    expect(f).toMatchObject({ ok: true });
    expect((f.result as string[]).sort()).toEqual(["src/worker.ts", "test/worker.test.ts"]);
    await s.relay.request({ type: "session.prompt", v: 1, callsign: "site@laptop", text: "Сравни с @src/worker.ts" });
    const p = s.proc("site@laptop");
    await until(() => p.inputs.length === 1);
    expect(p.inputs[0].message.content).toBe("Сравни с @src/worker.ts");
    expect(JSON.stringify(p.inputs[0])).not.toContain("client_composed");
  });
});

describe("chat: юнит и стыки", () => {
  it("text/plain — документ с текстом; без вложений — строка", () => {
    expect(content("x", [])).toBe("x");
    expect(content("", [{ name: "n.txt", media_type: "text/plain", data: b64("заметка") }])).toEqual([
      { type: "document", source: { type: "text", media_type: "text/plain", data: "заметка" } },
    ]);
  });

  it("остановленная сессия — stopped, ввод не тронут", async () => {
    const s = await bench();
    const sess = await s.open("site@laptop");
    const p = s.proc("site@laptop");
    await sess.stop();
    const r = await s.relay.request({ type: "session.prompt", v: 1, callsign: "site@laptop", text: "привет" });
    expect(r).toMatchObject({ ok: false, error: "stopped" });
    expect(p.inputs).toHaveLength(0);
  });

  it("история страницами: before и more", async () => {
    const s = await bench();
    await s.open("site@laptop");
    const rec = Array.from({ length: 14 }, (_, i) => ({ type: "user", uuid: `u${i + 1}` }));
    s.sdk.functions = conversation(async () => rec);
    const page = async (before: string | null) => (await s.relay.request({ type: "session.history", v: 1, callsign: "site@laptop", before, limit: 6 })).result as { messages: Array<{ uuid: string }>; more: boolean };
    const p1 = await page(null);
    expect(p1.messages.map((m) => m.uuid)).toEqual(["u9", "u10", "u11", "u12", "u13", "u14"]);
    expect(p1.more).toBe(true);
    const p3 = await page("u3");
    expect(p3).toEqual({ messages: [{ type: "user", uuid: "u1" }, { type: "user", uuid: "u2" }], more: false });
    expect(await s.relay.request({ type: "session.history", v: 1, callsign: "site@laptop", before: null })).toMatchObject({ ok: false, error: "bad_frame" });
  });

  it("session.files: папка не в git — все файлы, limit клиента", async () => {
    const s = await bench();
    await s.open("site@laptop", { cwd: folder(false) });
    const f = await s.relay.request({ type: "session.files", v: 1, callsign: "site@laptop", query: "WORKER", limit: 2 });
    expect(f.result).toHaveLength(2);
    const all = await s.relay.request({ type: "session.files", v: 1, callsign: "site@laptop", query: "worker", limit: 20 });
    expect((all.result as string[]).sort()).toEqual(["build/worker.js", "src/worker.ts", "test/worker.test.ts"]);
  });

  it("promptSuggestions: true — вклад в query()", async () => {
    const s = await bench();
    await s.open("site@laptop");
    expect(s.query("site@laptop").options).toMatchObject({ promptSuggestions: true });
  });
});

describe("chat: покрытие плана host-modules", () => {
  it("3001 · session.prompt: text не строка — bad_frame; во ввод ничего, chat жив", async () => {
    // источник: чьё: код (chat.ts:41)
    const s = await bench();
    await s.open("site@laptop");
    const p = s.proc("site@laptop");
    expect(await s.relay.request({ type: "session.prompt", v: 1, callsign: "site@laptop", text: 5 })).toMatchObject({ ok: false, error: "bad_frame" });
    expect(await s.relay.request({ type: "session.prompt", v: 1, callsign: "site@laptop", text: "x" })).toMatchObject({ ok: true });
    await until(() => p.inputs.length === 1);
    expect(p.inputs).toHaveLength(1);
  });

  it("3002 · session.prompt занятой сессии: ответ сразу, ввод с priority next", async () => {
    // источник: чьё: код (chat.ts:46)
    const s = await bench();
    const sess = await s.open("site@laptop");
    const p = s.proc("site@laptop");
    p.send(stand.msg.state("running"));
    await until(() => sess.state === "busy");
    const r = await s.relay.request({ type: "session.prompt", v: 1, callsign: "site@laptop", text: "ещё" });
    expect(r).toMatchObject({ ok: true });
    await until(() => p.inputs.length === 1);
    expect(p.inputs[0]).toMatchObject({ priority: "next", message: { content: "ещё" } });
  });

  it("3003 · session.prompt сессии failed — stopped; после session.start ввод проходит", async () => {
    // источник: чьё: код (chat.ts:27, :42; chat/contract.ts:5 «поднимает session.start»)
    const s = await bench();
    const sess = await s.open("site@laptop");
    s.holders.failInitNext = 1;
    s.proc("site@laptop").exit(1, "первый");
    await until(() => s.sdk.of("site@laptop").length === 2 && s.holders.procs.get("site@laptop")?.initializes === 1);
    s.proc("site@laptop").exit(1, "второй");
    await until(() => sess.state === "failed");
    expect(await s.relay.request({ type: "session.prompt", v: 1, callsign: "site@laptop", text: "x" })).toMatchObject({ ok: false, error: "stopped" });
    await sess.start();
    expect(await s.relay.request({ type: "session.prompt", v: 1, callsign: "site@laptop", text: "x" })).toMatchObject({ ok: true });
    await until(() => s.proc("site@laptop").inputs.length === 1);
  });

  it("3004 · session.history: новая сессия — пустая страница; остановленной — читается", async () => {
    // источник: чьё: код (chat.ts:49-61; getSessionMessages — функция SDK по файлу, процесс не нужен)
    const s = await bench();
    const sess = await s.open("site@laptop");
    s.sdk.functions = conversation(async () => []);
    expect(await s.relay.request({ type: "session.history", v: 1, callsign: "site@laptop", before: null, limit: 5 })).toMatchObject({ ok: true, result: { messages: [], more: false } });
    await sess.stop();
    const rec = [{ type: "user", uuid: "u1" }];
    s.sdk.functions = conversation(async () => rec);
    expect(await s.relay.request({ type: "session.history", v: 1, callsign: "site@laptop", before: null, limit: 5 })).toMatchObject({ ok: true, result: { messages: rec, more: false } });
  });

  it("3005 · session.history: SDK не прочёл разговор — module_error, chat выключен в сессии, roster failed", async () => {
    // источник: слово пользователя (устав: «ошибка модуля — модуль выключен, в roster failed»)
    const s = await bench();
    await s.open("site@laptop");
    s.sdk.functions = conversation(async () => { throw new Error("файл разговора не читается"); });
    expect(await s.relay.request({ type: "session.history", v: 1, callsign: "site@laptop", before: null, limit: 5 })).toMatchObject({ ok: false, error: "module_error" });
    await until(() => s.states("site@laptop").at(-1)?.failed?.["host-chat"]);
    expect(s.journal().some((l) => l.ev === "module_failed" && l.module === "host-chat")).toBe(true);
  });

  it("3006 · session.files: без limit — bad_frame", async () => {
    // источник: чьё: код (chat.ts:67)
    const s = await bench();
    await s.open("site@laptop", { cwd: folder(false) });
    expect(await s.relay.request({ type: "session.files", v: 1, callsign: "site@laptop", query: "a" })).toMatchObject({ ok: false, error: "bad_frame" });
  });

  it("3007 · session.files: обход папки не в git упал — module_error, chat выключен в сессии, Host жив", async () => {
    // источник: слово пользователя (устав: «ошибка модуля — модуль выключен, в roster failed»; «система ловит … не пускает дальше»)
    const s = await bench();
    const gone = folder(false);
    await s.open("site@laptop", { cwd: gone });
    await s.open("wiki@laptop", { cwd: folder(true) });
    rmSync(gone, { recursive: true, force: true });
    const r = await s.relay.request({ type: "session.files", v: 1, callsign: "site@laptop", query: "", limit: 5 });
    expect(r).toMatchObject({ ok: false, error: "module_error" });
    expect(s.journal().find((l) => l.ev === "module_failed" && l.module === "host-chat")).toMatchObject({ kind: "stop", callsign: "site@laptop" });
    s.proc("site@laptop").send(stand.msg.state("idle"));
    await until(() => s.states("site@laptop").at(-1)?.failed?.["host-chat"]);
    expect(await s.relay.request({ type: "session.files", v: 1, callsign: "wiki@laptop", query: "worker", limit: 5 })).toMatchObject({ ok: true });
  });
});
