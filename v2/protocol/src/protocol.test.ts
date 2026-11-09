import { describe, expect, it } from "vitest";
import { contract, createApi, fail, kindOf, machineOf, ok, parseFrame, parsePass, personOf, request, sessionOpen, Spec, z, type Transport } from "./index.ts";

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
