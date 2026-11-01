import { describe, expect, it } from "vitest";
import { fail, isReply, kindOf, machineOf, ok, parseFrame, userOf } from "./contract.ts";

describe("protocol: конверт кадра", () => {
  it("разбирает кадр с type и полями владельца", () => {
    const f = parseFrame('{"type":"session.history","id":"h-3","v":1,"callsign":"site@laptop","before":"x"}');
    expect(f).toEqual({ type: "session.history", id: "h-3", v: 1, callsign: "site@laptop", before: "x" });
  });

  it.each(["не json", "[]", "null", '{"id":"1"}', '{"type":""}', '{"type":"a","id":5}', '{"type":"a","v":"1"}'])(
    "не кадр — null: %s",
    (t) => expect(parseFrame(t)).toBeNull(),
  );

  it("reply: ok и отказ словом", () => {
    expect(ok("h-3", { n: 1 })).toEqual({ type: "reply", id: "h-3", ok: true, result: { n: 1 } });
    expect(ok("h-3")).toEqual({ type: "reply", id: "h-3", ok: true });
    expect(fail("h-3", "offline")).toEqual({ type: "reply", id: "h-3", ok: false, error: "offline" });
    expect(isReply(fail("x", "e"))).toBe(true);
    expect(isReply({ type: "message" })).toBe(false);
  });

  it("машина адреса", () => {
    expect(machineOf("site@laptop")).toBe("laptop");
    expect(machineOf("@pc")).toBe("pc");
    expect(machineOf("phone")).toBeNull();
    expect(machineOf("x@")).toBeNull();
    expect(machineOf(".keeper@win")).toBe("win");
    expect(machineOf("phone~yuri@example.com")).toBeNull();
    expect(machineOf(".points")).toBeNull();
  });

  it("вид адреса по форме: точка — системное имя, тильда — человек по email", () => {
    expect(kindOf(".releases")).toBe("service");
    expect(kindOf(".keeper@win")).toBe("part");
    expect(kindOf("@win")).toBe("machine");
    expect(kindOf("site@win")).toBe("session");
    expect(kindOf("~yuri@example.com")).toBe("user");
    expect(kindOf("phone~yuri@example.com")).toBe("device");
    for (const bad of ["phone", "", ".", "x@", "~", "a~", ".@w", ".k@", 5]) expect(kindOf(bad)).toBeNull();
    expect(userOf("phone~yuri@example.com")).toBe("yuri@example.com");
    expect(userOf("~yuri@example.com")).toBe("yuri@example.com");
    expect(userOf("site@win")).toBeNull();
  });
});
