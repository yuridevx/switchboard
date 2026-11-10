import { describe, expect, it } from "vitest";
import { socketLink } from "./client.ts";
import { accountList, contract, createApi, fail, kindOf, machineOf, ok, parseFrame, parsePass, personOf, request, sessionOpen, slotSet, slotSwap, Spec, TOOL_METHODS, z, type Transport } from "./index.ts";

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
  it("очереди аккаунтов: очередь сессии — поле slot её документа; slot.set и slot.swap называют очередь; account.list отдаёт очереди", () => {
    expect(Spec.parse({ name: "site", cwd: "~/p", slot: "review" }).slot).toBe("review");
    // закрепления за аккаунтом в документе нет: такого ключа схема не знает
    expect("account" in Spec.parse({ name: "site", cwd: "~/p", account: "a@b.c" })).toBe(false);
    expect(slotSet.input.safeParse({ to: "@laptop", order: ["a@b.c"] }).success).toBe(false);
    expect(slotSet.input.safeParse({ to: "@laptop", slot: "review", order: [] }).success).toBe(true);
    expect(slotSwap.input.safeParse({ to: "@laptop" }).success).toBe(false);
    expect(slotSwap.input.safeParse({ to: "@laptop", slot: "main", account: "a@b.c" }).success).toBe(true);
    expect(accountList.output.safeParse({ accounts: [] }).success).toBe(false);
    expect(accountList.output.parse({ accounts: [], slots: [{ name: "main", order: ["a@b.c"], account: "a@b.c", sessions: 2 }] }).slots[0]).toEqual({ name: "main", order: ["a@b.c"], account: "a@b.c", sessions: 2 });
    expect(contract.tools().map((d) => d.name)).toEqual(expect.arrayContaining(["slot.set", "slot.swap"]));
  });
  it("ведущая управляет ведомым инструментами: откат и действия session.call из закрытого списка; отката файлов отдельным методом и запроса сжатия нет", () => {
    const tools = contract.tools().map((d) => d.name);
    expect(tools).toEqual(expect.arrayContaining(["session.rewind", "session.call", "machine.conversations"]));
    expect(contract.request("session.compact")).toBeUndefined();
    const call = contract.request("session.call")!;
    expect(call.input.safeParse({ to: "a@b", method: "rewindFiles" }).success).toBe(false);
    for (const method of TOOL_METHODS) expect(call.input.safeParse({ to: "a@b", method }).success).toBe(true);
  });
});
