import { describe, expect, it } from "vitest";
import { fail, isReply, kindOf, machineOf, MAX_FRAME, ok, oversize, parseFrame, serviceAddress } from "./contract.ts";

describe("protocol: конверт кадра", () => {
  it("2001 · кадр по конверту разобран; isReply отличает ответ", () => {
    const f = parseFrame('{"type":"session.history","id":"h-3","v":1,"callsign":"site@laptop","before":"x"}');
    expect(f).toEqual({ type: "session.history", id: "h-3", v: 1, callsign: "site@laptop", before: "x" });
    expect(isReply(f!)).toBe(false);
    expect(isReply(parseFrame('{"type":"reply","id":"h-3","ok":true}')!)).toBe(true);
  });

  it.each(["не json", "[]", "null", '{"id":"1"}', '{"type":""}', '{"type":"a","id":5}', '{"type":"a","v":"1"}'])(
    "не кадр — null: %s",
    (t) => expect(parseFrame(t)).toBeNull(),
  );

  it("2003 · reply без ok или без id — не ответ", () => {
    for (const t of ['{"type":"reply","id":"m1"}', '{"type":"reply","id":"m1","ok":"yes"}', '{"type":"reply","ok":true}']) {
      const f = parseFrame(t);
      expect(f).not.toBeNull();
      expect(isReply(f!)).toBe(false);
    }
  });

  it("2002 · кадр больше 32 МиБ узнан по байтам UTF-8", () => {
    // чьё: код — предел MAX_FRAME, короткий текст без подсчёта
    expect(oversize("x".repeat(100))).toBeNull();
    expect(oversize("x".repeat(MAX_FRAME))).toBeNull();
    // «я» — 2 байта: знаков меньше предела, байтов больше
    const big = "я".repeat(MAX_FRAME / 2) + "x";
    expect(big.length).toBeLessThan(MAX_FRAME);
    expect(oversize(big)).toBe(MAX_FRAME + 1);
  });

  it("reply: ok и отказ словом", () => {
    expect(ok("h-3", { n: 1 })).toEqual({ type: "reply", id: "h-3", ok: true, result: { n: 1 } });
    expect(ok("h-3")).toEqual({ type: "reply", id: "h-3", ok: true });
    expect(fail("h-3", "offline")).toEqual({ type: "reply", id: "h-3", ok: false, error: "offline" });
    expect(isReply(fail("x", "e"))).toBe(true);
    expect(isReply({ type: "message" })).toBe(false);
  });

  it("2004 · шесть видов адреса по форме и машина адреса", () => {
    // источник: слово пользователя «Адреса по форме: служба .relay, часть машины .keeper@laptop, машина @laptop, сессия site@laptop, пользователь ~email, устройство phone~email»
    expect(kindOf(".releases")).toBe("service");
    expect(kindOf(".keeper@win")).toBe("part");
    expect(kindOf("@win")).toBe("machine");
    expect(kindOf("site@win")).toBe("session");
    expect(kindOf("~yuri@example.com")).toBe("user");
    expect(kindOf("phone~yuri@example.com")).toBe("device");
    expect(machineOf("site@laptop")).toBe("laptop");
    expect(machineOf("@pc")).toBe("pc");
    expect(machineOf(".keeper@win")).toBe("win");
    expect(machineOf("phone~yuri@example.com")).toBeNull();
    expect(machineOf("~yuri@example.com")).toBeNull();
    expect(machineOf(".points")).toBeNull();
    expect(serviceAddress("ledger")).toBe(".ledger");
    expect(kindOf(serviceAddress("ledger"))).toBe("service");
  });

  it("2005 · голое имя и обрубки — не адрес", () => {
    // источник: слово пользователя «голых имён нет»
    for (const bad of ["phone", "", ".", "x@", "~", "a~", ".@w", ".k@", 5]) expect(kindOf(bad)).toBeNull();
    expect(machineOf("phone")).toBeNull();
    expect(machineOf("x@")).toBeNull();
  });
});
