import { describe, expect, it, vi } from "vitest";
import { socketLink } from "./client.ts";
import { accountList, CLAUDE, contract, createApi, fail, findModels, kindOf, machineOf, ok, parseFrame, parsePass, personOf, request, sessionOpen, Spec, TOOL_METHODS, z, type Transport } from "./index.ts";

describe("protocol", () => {
  it("адреса по форме; голое имя — не адрес", () => {
    expect([".archive", ".keeper@win", "@win", "site@win", "~a@b.c", "pult~a@b.c"].map(kindOf)).toEqual(["service", "keeper", "machine", "session", "person", "device"]);
    for (const bad of ["phone", "", ".", "x@", "~", "a~", ".x@w", 5]) expect(kindOf(bad)).toBeNull();
    expect(machineOf("site@laptop")).toBe("laptop");
    expect(machineOf("~a@b.c")).toBeNull();
    expect(personOf("pult~a@b.c")).toBe("~a@b.c");
  });
  it("пропуск: флот, номер, секрет", () => {
    expect(parsePass("home:k8f3a2:0123456789abcdef0123")).toEqual({ fleet: "home", kid: "k8f3a2", secret: "0123456789abcdef0123" });
    for (const bad of ["home:k8f3a2", "home:k:short", 7, "a:b:c:d"]) expect(parsePass(bad)).toBeNull();
  });
  it("кадр: не кадр — null; reply узнаётся", () => {
    expect(parseFrame('{"type":"message","id":"1"}')).toEqual({ type: "message", id: "1" });
    for (const t of ["null", "[]", '{"id":"1"}', '{"type":"a","id":5}']) expect(parseFrame(t)).toBeNull();
    expect(ok("1", { a: 1 })).toEqual({ type: "reply", id: "1", ok: true, result: { a: 1 } });
    expect(fail("1", "offline")).toEqual({ type: "reply", id: "1", ok: false, error: "offline" });
  });
  it("у имени один хозяин: второе объявление падает", () => {
    expect(() => request("session.open", { owner: "x", target: "machine", input: z.object({}), output: z.object({}) })).toThrow(/session.open уже у host/);
  });
  it("инструменты — запросы с описанием для модели", () => {
    const tools = contract.tools().map((d) => d.name);
    expect(tools).toContain("session.open");
    expect(tools).toContain("message");
    expect(tools).not.toContain("keys.value");
  });
  it("документ сессии: имя и папка обязательны", () => {
    expect(Spec.safeParse({ name: "site", cwd: "~/p" }).success).toBe(true);
    expect(Spec.safeParse({ name: "site" }).success).toBe(false);
  });
  it("вызов: кадр несёт имя, id и trace; отказ — исключение со словом", async () => {
    const seen: unknown[] = [];
    const t: Transport = {
      call: async (f) => (seen.push(f), f.to === "@gone" ? fail(f.id!, "offline", "машина не на связи") : ok(f.id!, { callsign: "site@laptop" })),
      open: () => ({ send() {}, close() {} }),
    };
    const api = createApi(t);
    await expect(api.call(sessionOpen, { to: "@laptop", spec: { name: "site", cwd: "~/p" } })).resolves.toEqual({ callsign: "site@laptop" });
    expect(seen[0]).toMatchObject({ type: "session.open", to: "@laptop" });
    expect((seen[0] as any).trace).toMatch(/^t/);
    await expect(api.call(sessionOpen, { to: "@gone", spec: { name: "site", cwd: "~/p" } })).rejects.toMatchObject({ word: "offline" });
  });
});

import { toolLine, toolLook, toolWord } from "./index.ts";
describe("инструменты: одна таблица для страницы и Host", () => {
  it("подпись по-русски, суть вызова одной строкой, сервер MCP — «сервер · инструмент»", () => {
    expect(toolLine("Bash", { command: "npm test\nnpm run build" })).toBe("Команда npm test");
    expect(toolLine("Read", { file_path: "src/a.ts", offset: 10, limit: 5 })).toBe("Чтение src/a.ts · с 10 · 5 строк");
    expect(toolLine("TodoWrite", { todos: [{ status: "completed" }, { status: "pending" }] })).toBe("Задачи 1 из 2 готово");
    expect(toolWord("mcp__fleet__message")).toBe("fleet · message");
    expect(toolLine("Unknown", { x: "первое строковое" })).toBe("Unknown первое строковое");
    expect(toolLine("Bash", { command: "x".repeat(300) }, 40).length).toBe(40);
    expect(toolLook({ name: "Edit", input: { file_path: "a.ts" } })).toEqual({ word: "Правка", icon: "file-pen", body: "diff", open: true, sum: "a.ts" });
  });
  it("соединение закрыто словом access — переподключение сразу и без «нет связи»; обычный обрыв — closed", () => {
    const made: Array<{ on: Record<string, (e: any) => void> }> = [];
    class WS { on: Record<string, (e: any) => void> = {}; readyState = 1; constructor() { made.push(this); } send() {} close() {} addEventListener(t: string, fn: (e: any) => void) { this.on[t] = fn; } }
    const states: string[] = [];
    const link = socketLink({ url: "ws://x", hello: { type: "hello" }, onFrame: () => {}, onState: (st) => states.push(st), WebSocket: WS as never });
    made[0]!.on.open!({});
    made[0]!.on.close!({ reason: "access" });
    expect(made.length).toBe(2);
    expect(states).toEqual(["connecting", "open"]);
    made[1]!.on.open!({});
    made[1]!.on.close!({});
    expect(states).toEqual(["connecting", "open", "open", "closed"]);
    link.close();
  });
  it("документ сессии называет провайдера и точную модель; очередей, входов и Remote Control в договоре нет", () => {
    const doc = Spec.parse({ name: "site", cwd: "~/p", key: "orca", model: "qwen-3.5-coder", slot: "review", remote: true, account: "a@b.c" });
    expect(doc).toEqual({ name: "site", cwd: "~/p", key: "orca", model: "qwen-3.5-coder" });
    for (const gone of ["account.login", "account.code", "account.remove", "slot.set", "slot.swap"]) expect(contract.request(gone)).toBeUndefined();
    const call = contract.request("session.call")!;
    for (const method of ["models", "usage"]) expect(call.input.safeParse({ to: "a@b", method }).success).toBe(false);
    // аккаунт глазами машины: имя, окна из ответов Claude, флаг запаса; очередей в ответе нет
    const account = { name: "a@b.c", ok: true, limits: [{ name: "seven_day", used: 0.4, resets: 1 }], keep: true };
    expect(accountList.output.parse({ accounts: [{ ...account, kind: "claude" }], slots: [] })).toEqual({ accounts: [account] });
    expect(contract.tools().map((d) => d.name)).toEqual(expect.arrayContaining(["keys.models", "log.query", "account.list"]));
    expect(contract.request("log.write")!.machineOnly).toBe(true);
  });
  // эталон «/model opus 4.8» и «/model opus — подходят несколько»: одно правило «слова → модели» для страницы и машины
  it("слова → модели: все слова нашлись в имени, семействе или провайдере; точное имя выигрывает", () => {
    const offers = [
      { key: CLAUDE, model: "claude-opus-4-8", name: "Claude Opus 4.8", family: "Opus" }, { key: CLAUDE, model: "claude-opus-5-5", name: "Claude Opus 5.5", family: "Opus" },
      { key: CLAUDE, model: "claude-fable-5-2", family: "Fable" }, { key: "orca", model: "glm-5.3" }, { key: "orca", model: "glm-5.3-air" },
    ];
    const found = (words: string) => findModels(words, offers).map((o) => `${o.key}/${o.model}`);
    expect(found("opus 4.8")).toEqual(["claude/claude-opus-4-8"]);
    expect(found("opus")).toEqual(["claude/claude-opus-4-8", "claude/claude-opus-5-5"]);
    expect(found("orca")).toEqual(["orca/glm-5.3", "orca/glm-5.3-air"]);
    expect(found("glm-5.3")).toEqual(["orca/glm-5.3"]);
    expect(found("qwen")).toEqual([]);
  });
  it("ведущая управляет ведомым инструментами: откат и действия session.call из закрытого списка; отката файлов отдельным методом и запроса сжатия нет", () => {
    const tools = contract.tools().map((d) => d.name);
    expect(tools).toEqual(expect.arrayContaining(["session.rewind", "session.call", "machine.conversations"]));
    expect(contract.request("session.compact")).toBeUndefined();
    const call = contract.request("session.call")!;
    expect(call.input.safeParse({ to: "a@b", method: "rewindFiles" }).success).toBe(false);
    for (const method of TOOL_METHODS) expect(call.input.safeParse({ to: "a@b", method }).success).toBe(true);
  });
  // устав: закрытый список ожидаемых веток — «соединение оборвалось → клиенты переподключаются»
  it("соединение оборвалось: «нет связи», после паузы — новое соединение и hello тем же пропуском; слово revoked переподключение останавливает", () => {
    vi.useFakeTimers();
    try {
      const made: Array<{ on: Record<string, (e: any) => void>; sent: string[] }> = [];
      class WS { on: Record<string, (e: any) => void> = {}; sent: string[] = []; readyState = 1; constructor() { made.push(this); } send(t: string) { this.sent.push(t); } close() {} addEventListener(t: string, fn: (e: any) => void) { this.on[t] = fn; } }
      const states: string[] = [], pauses: number[] = [];
      socketLink({ url: "ws://x", hello: { type: "hello", key: "k1", role: "page" }, onFrame: () => {}, onState: (st, why) => states.push(why ? `${st}:${why}` : st), onPause: (ms) => pauses.push(ms), WebSocket: WS as never });
      made[0]!.on.open!({});
      made[0]!.on.close!({});
      expect(states).toEqual(["connecting", "open", "closed"]);
      expect(made.length).toBe(1);
      expect(pauses[0]).toBeGreaterThan(0);
      vi.advanceTimersByTime(pauses[0]! + 1);
      expect(made.length).toBe(2);
      made[1]!.on.open!({});
      expect(JSON.parse(made[1]!.sent[0]!)).toEqual({ type: "hello", key: "k1", role: "page" });
      expect(states.slice(3)).toEqual(["connecting", "open"]);
      made[1]!.on.close!({ reason: "revoked" });
      vi.advanceTimersByTime(60_000);
      expect(made.length).toBe(2);
      expect(states.at(-1)).toBe("stopped:revoked");
    } finally {
      vi.useRealTimers();
    }
  });
});
