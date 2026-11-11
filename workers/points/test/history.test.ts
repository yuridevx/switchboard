// Леса points.history: вход — кадр points.history, файл разговора точки — блоками в хранилище (стенд blocks, тела по ссылке GET);
// исход — ответ. Разговор — fixtures/history.jsonl, ответ SDK с диска для него — history.expected.json (make-history.mjs).
import { createHash } from "node:crypto";
import { zstdCompressSync } from "node:zlib";
import { applyD1Migrations, env, type D1Migration } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BlocksStand } from "@switchboard/blocks";
import type { Frame } from "@switchboard/protocol";
import expected from "./fixtures/history.expected.json" with { type: "json" };
import text from "./fixtures/history.jsonl?raw";

type Db = { DB: D1Database; TEST_MIGRATIONS: D1Migration[] };
const E = env as unknown as Db;
const STORE = (env as unknown as { STORE: BlocksStand }).STORE;
const worker = (exports as unknown as { default: { frame(f: Frame): Promise<Frame[]> } }).default;
const SID = expected.sid;

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
/** Тела блоков по отпечатку: то, что Host выгрузил по ссылкам PUT. */
const bodies = new Map<string, Uint8Array>();

/** Файл разговора — блоками по переводу строки, как режет host-points; блоки в хранилище, тела — на «ссылке» GET. */
async function stored(conversation: string, at = 2): Promise<string[]> {
  const lines = conversation.split(/(?<=\n)/);
  const parts = [lines.slice(0, at).join(""), lines.slice(at).join("")].filter(Boolean).map((x) => new TextEncoder().encode(x));
  const hashes = parts.map(sha);
  for (const [i, h] of hashes.entries()) {
    bodies.set(h, new Uint8Array(zstdCompressSync(parts[i])));
    await STORE.put(h, parts[i].length);
  }
  return hashes;
}

const put = (sid: string, b: string[], extra: Record<string, unknown> = {}) =>
  worker.frame({ type: "points.put", v: 3, id: "p", to: ".points", from: "@laptop", sid, why: "rule", files: [{ p: `${sid}.jsonl`, size: 1, b }], ...extra });
const history = async (f: Record<string, unknown>) => (await worker.frame({ type: "points.history", v: 1, id: "h", to: ".points", from: "panel", sid: SID, before: null, limit: 50, ...f }))[0] as Frame & { ok: boolean; result: any; error?: string };

beforeEach(async () => {
  await applyD1Migrations(E.DB, E.TEST_MIGRATIONS);
  await E.DB.batch(["sessions", "points", "blocks", "refs", "meta", "sqlite_sequence"].map((x) => E.DB.prepare(`DELETE FROM ${x}`)));
  await STORE.clear();
  bodies.clear();
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
    const h = /\/b\/([0-9a-f]{64})\?m=GET$/.exec(String(input))?.[1];
    const body = h && bodies.get(h);
    return body ? new Response(body) : new Response(null, { status: 404 });
  });
});
afterEach(() => vi.restoreAllMocks());

describe("points.history", () => {
  it("39 · разговор точки — getSessionMessages SDK над строками файла: те же сообщения, что SDK читает с диска для session.history", async () => {
    await put(SID, await stored(text));
    const r = await history({});
    expect(r.ok).toBe(true);
    expect(r.result.messages).toEqual(expected.messages);
    expect(r.result).toMatchObject({ point: 1, more: false });
  });

  it("28 · страницы с конца по порядку файла, каждая запись один раз; before — запись, до которой читать", async () => {
    await put(SID, await stored(text, 5));
    const all = expected.messages.map((m: { uuid: string }) => m.uuid);
    const last = await history({ limit: 3 });
    expect([last.result.messages.map((m: { uuid: string }) => m.uuid), last.result.more]).toEqual([all.slice(-3), true]);
    const seen: string[] = [];
    let before: string | null = null;
    for (;;) {
      const r = await history({ before, limit: 3 });
      seen.unshift(...r.result.messages.map((m: { uuid: string }) => m.uuid));
      if (!r.result.more) break;
      before = r.result.messages[0].uuid;
    }
    expect(seen).toEqual(all);
    expect((await history({ before: "nope", limit: 3 })).error).toBe("bad_frame");
  });

  it("38 · вызовы модели — из записей api-request: три вызова, у каждого ответ, модель, токены и system; на странице — те, чей ответ на ней или назван в before", async () => {
    await put(SID, await stored(text));
    const r = await history({});
    const system = "You are Claude Code, Anthropic's official CLI for Claude.\n\n# Environment\nWorking directory: /home/ann/site";
    expect(r.result.calls).toEqual([
      { uuid: "a1", at: "2030-10-31T20:00:02.000Z", model: "claude-opus-5-5", tok_in: 1110, tok_out: 20, system },
      { uuid: "a2", at: "2030-10-31T20:00:06.000Z", model: "claude-opus-5-5", tok_in: 1130, tok_out: 40, system },
      { uuid: "a3", at: "2030-10-31T20:00:10.000Z", model: "claude-sonnet-5-5", tok_in: 1150, tok_out: 60, system },
    ]);
    const atCall = await history({ before: "a2", limit: 1 });
    expect(atCall.result.calls.map((c: { uuid: string }) => c.uuid)).toEqual(["a2"]);
  });

  it("точка — номер точки этой сессии; без номера — последняя; чужая или нет — no_point", async () => {
    const first = await stored(text.split("\n").slice(0, 8).join("\n") + "\n");
    await put(SID, first);
    await put(SID, await stored(text));
    expect((await history({ point: 1 })).result.messages.map((m: { uuid: string }) => m.uuid)).toEqual(["u1", "a1", "a1b", "u2", "a2"]);
    expect((await history({})).result.point).toBe(2);
    await put("other", first);
    expect((await history({ point: 3 })).error).toBe("no_point");
    expect((await history({ sid: "nope" })).error).toBe("no_point");
  });

  it("записей api-request в файле нет — calls пуст, строка журнала no_calls; разговор отдаётся", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((x: unknown) => void lines.push(String(x)));
    await put(SID, await stored(text.split("\n").filter((l) => !l.includes('"api-request')).join("\n")));
    const r = await history({});
    expect(r.result.calls).toEqual([]);
    expect(r.result.messages).toHaveLength(expected.messages.length);
    expect(lines.map((l) => JSON.parse(l) as { word?: string }).filter((l) => l.word === "no_calls")).toHaveLength(1);
  });

  it("блок по ссылке не тот — store_failed", async () => {
    const [h] = await stored(text, 99);
    bodies.set(h, new Uint8Array(zstdCompressSync(new TextEncoder().encode("{}\n"))));
    await put(SID, [h]);
    expect((await history({})).error).toBe("store_failed");
  });
});
