// Эталоны истории после сжатия: настоящие функции SDK на файле разговора в формате Claude Code.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSessionInfo, getSessionMessages, importSessionToStore } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { wholeConversation } from "../src/history.ts";
import { module, standHost } from "../stand/index.ts";

const sdk = { getSessionInfo, getSessionMessages, importSessionToStore } as never as Record<string, (...a: any[]) => Promise<unknown>>;
const SID = "44444444-4444-4444-8444-444444444444";
const base = { sessionId: SID, isSidechain: false, timestamp: "2026-11-03T00:00:00.000Z", cwd: "/proj", version: "2.1.0" };
const turn = (uuid: string, parentUuid: string | null, type: "user" | "assistant" = "user") => ({
  ...base,
  type,
  uuid,
  parentUuid,
  message: type === "user" ? { role: "user", content: `текст ${uuid}` } : { id: `m-${uuid}`, role: "assistant", model: "m", content: [{ type: "text", text: uuid }] },
});
const boundary = (uuid: string, logicalParentUuid: string, meta: object = {}) => ({
  ...base,
  type: "system",
  subtype: "compact_boundary",
  uuid,
  parentUuid: null,
  logicalParentUuid,
  compactMetadata: { trigger: "auto", preTokens: 1000, ...meta },
});
const summary = (uuid: string, parentUuid: string) => ({ ...turn(uuid, parentUuid), isCompactSummary: true });

/** n сообщений цепочкой: u0 ← a1 ← u2 … */
function chain(prefix: string, n: number, parent: string | null): Array<ReturnType<typeof turn>> {
  const out = [];
  let p = parent;
  for (let i = 0; i < n; i++) {
    const u = `${prefix}${i}`;
    out.push(turn(u, p, i % 2 ? "assistant" : "user"));
    p = u;
  }
  return out;
}

describe("история после сжатия", () => {
  let cfg: string;
  let dir: string;
  const prevCfg = process.env.CLAUDE_CONFIG_DIR;
  const write = (records: unknown[]) => {
    const project = join(cfg, "projects", dir.replace(/[^a-zA-Z0-9]/g, "-"));
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, `${SID}.jsonl`), records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  };
  const uuids = (m: unknown) => (m as Array<{ uuid: string }>).map((x) => x.uuid);

  beforeEach(() => {
    cfg = mkdtempSync(join(tmpdir(), "sb-history-"));
    dir = join(cfg, "proj");
    mkdirSync(dir);
    process.env.CLAUDE_CONFIG_DIR = cfg;
  });
  afterEach(() => {
    if (prevCfg === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prevCfg;
    rmSync(cfg, { recursive: true, force: true });
  });

  it("5531 · 32 сообщения до сжатия и 7 после: вернулись все — до этой склейки SDK отдавал только хвост", async () => {
    // источник: опыт на SDK 0.3.311 (32 + 7, вернулось 9), бэклог «История чата обрывается на последнем сжатии контекста»
    const before = chain("b", 32, null);
    const after = chain("c", 7, "s");
    write([...before, boundary("x", "b31"), summary("s", "x"), ...after]);
    const plain = uuids(await getSessionMessages(SID, { dir }));
    expect(plain.length).toBeLessThan(10);
    const all = uuids(await wholeConversation(sdk, SID, { dir }));
    expect(all).toEqual([...before.map((m) => m.uuid), "s", ...after.map((m) => m.uuid)]);
  });

  it("5532 · два сжатия: сообщения до, между и после обоих, по порядку", async () => {
    // источник: PR #1430 claude-agent-acp («for a session compacted twice…»), настоящий файл с двумя границами 3 нояб.
    const a = chain("a", 4, null);
    const b = chain("b", 4, "s1");
    const c = chain("c", 2, "s2");
    write([...a, boundary("x1", "a3"), summary("s1", "x1"), ...b, boundary("x2", "b3"), summary("s2", "x2"), ...c]);
    expect(uuids(await wholeConversation(sdk, SID, { dir }))).toEqual([...a.map((m) => m.uuid), "s1", ...b.map((m) => m.uuid), "s2", ...c.map((m) => m.uuid)]);
  });

  it("5533 · сжатие с сохранёнными сообщениями: они на своём месте и один раз, цепочка не зациклена", async () => {
    // источник: PR #1430 claude-agent-acp (сведения о сохранённых зацикливают цепочку)
    const a = chain("a", 6, null);
    const meta = { preservedSegment: { headUuid: "a4", anchorUuid: "s", tailUuid: "a5" }, preservedMessages: ["a4", "a5"] };
    write([...a, boundary("x", "a5", meta), summary("s", "x"), turn("z", "s")]);
    expect(uuids(await wholeConversation(sdk, SID, { dir }))).toEqual([...a.map((m) => m.uuid), "s", "z"]);
  });

  it("5534 · ссылка границы ведёт в никуда — родитель: предыдущее сообщение файла; история не обрывается", async () => {
    // источник: настоящий файл 3 нояб. (1 из 6): logicalParentUuid нет среди записей
    const a = chain("a", 4, null);
    // запись субагента перед границей родителем не становится
    const side = { ...turn("side", "a3"), isSidechain: true };
    write([...a, side, boundary("x", "нет-такой"), summary("s", "x"), turn("z", "s")]);
    expect(uuids(await wholeConversation(sdk, SID, { dir }))).toEqual([...a.map((m) => m.uuid), "s", "z"]);
  });

  it("5536 · s.sdk модуля (session.history, points) — весь разговор: сессии с папкой и записи с границей уже со ссылкой", async () => {
    // источник: бэклог «Задевает session.history и points» — оба зовут s.sdk("getSessionMessages")
    const m = module("host-reader", {}, { calls: ["getSessionMessages"] });
    const st = await standHost({ modules: [m] });
    await st.open("site@laptop");
    const s = st.session("host-reader", "site@laptop")!;
    let seen: any;
    st.sdk.functions = {
      getSessionInfo: async () => ({}),
      importSessionToStore: async (_sid: string, store: any) => void (await store.append({}, [turn("b1", null), boundary("x", "b1")])),
      getSessionMessages: async (sid: string, o: any) => ((seen = { sid, o, entries: await o.sessionStore.load() }), ["весь разговор"]),
    } as never;
    expect(await s.sdk("getSessionMessages", { includeSystemMessages: true })).toEqual(["весь разговор"]);
    expect(seen).toMatchObject({ sid: s.info.session_id, o: { dir: s.info.cwd, includeSystemMessages: true } });
    expect(seen.entries[1].parentUuid).toBe("b1");
    await st.close();
  });

  it("5535 · без сжатия — как у SDK; опции проходят; файла ещё нет — пустой разговор", async () => {
    // чьё: код — session.history и points зовут getSessionMessages с опциями; новая сессия до первого хода без файла
    expect(await wholeConversation(sdk, SID, { dir })).toEqual([]);
    const a = chain("a", 5, null);
    write(a);
    expect(await wholeConversation(sdk, SID, { dir })).toEqual(await getSessionMessages(SID, { dir }));
    expect(uuids(await wholeConversation(sdk, SID, { dir, limit: 2 }))).toEqual(["a0", "a1"]);
  });
});
