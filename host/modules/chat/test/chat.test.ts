// Эталоны и стыки модуля chat на стенде Host: поддельные SDK, relay, keeper и часы.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stand } from "@switchboard/host";
import type { Manifest } from "@switchboard/host";
import manifest from "../module.json" with { type: "json" };
import { content, make } from "../src/chat.ts";

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

describe("эталоны chat", () => {
  it("15 · session.prompt простаивающей сессии: ввод человека без обёртки, ход, reply ok; session.history отдаёт это сообщение", async () => {
    const s = await bench();
    const sess = await s.open("site@laptop");
    const r = await s.relay.request({ type: "session.prompt", v: 1, callsign: "site@laptop", uuid: "9c4d", text: "Почини сборку" });
    expect(r).toMatchObject({ ok: true, result: { uuid: "9c4d" } });
    const p = s.proc("site@laptop");
    await until(() => p.inputs.length === 1);
    expect(p.inputs[0]).toMatchObject({ type: "user", priority: "next", uuid: "9c4d", origin: { kind: "human" }, message: { role: "user", content: "Почини сборку" } });
    expect(sess.info.from).toBe("panel-desk");
    turn(p, "Смотрю, что падает.");
    await until(() => sess.state === "idle" && s.states("site@laptop").some((f) => f.state === "busy"));

    const rec = [
      { type: "user", uuid: "9c4d", session_id: sess.info.session_id, message: { role: "user", content: "Почини сборку" }, parent_tool_use_id: null, parent_agent_id: null },
      { type: "assistant", uuid: "a1", session_id: sess.info.session_id, message: {}, parent_tool_use_id: null, parent_agent_id: null },
    ];
    const calls: unknown[][] = [];
    s.sdk.functions = { getSessionMessages: async (...a: unknown[]) => (calls.push(a), rec) };
    const h = await s.relay.request({ type: "session.history", v: 1, callsign: "site@laptop", before: null, limit: 50 });
    expect(h).toMatchObject({ ok: true, result: { messages: rec, more: false } });
    expect(calls).toEqual([[sess.info.session_id, { dir: sess.info.cwd, includeSystemMessages: true }]]);
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
    await sess.stop();
    const r = await s.relay.request({ type: "session.prompt", v: 1, callsign: "site@laptop", text: "привет" });
    expect(r).toMatchObject({ ok: false, error: "stopped" });
  });

  it("история страницами: before и more", async () => {
    const s = await bench();
    await s.open("site@laptop");
    const rec = Array.from({ length: 14 }, (_, i) => ({ type: "user", uuid: `u${i + 1}` }));
    s.sdk.functions = { getSessionMessages: async () => rec };
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
