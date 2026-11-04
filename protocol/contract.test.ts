import { describe, expect, it, vi } from "vitest";
import { withLimit, accepts, CALL_MS, fail, hostOf, isReply, kindOf, machineOf, MAX_FRAME, nameOf, ok, oversize, parseFrame, reaches, serviceAddress, userOf, within } from "./contract.ts";

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
    expect(nameOf("site@laptop")).toBe("site");
    expect(nameOf("site")).toBe("site");
    expect(machineOf("site@laptop")).toBe("laptop");
    expect(machineOf("@pc")).toBe("pc");
    expect(machineOf(".keeper@win")).toBe("win");
    expect(machineOf("phone~yuri@example.com")).toBeNull();
    expect(machineOf("~yuri@example.com")).toBeNull();
    expect(machineOf(".points")).toBeNull();
    expect(serviceAddress("ledger")).toBe(".ledger");
    expect(kindOf(serviceAddress("ledger"))).toBe("service");
  });

  it("2085 · адрес человека доходит до его устройств и только до них; адрес устройства — только до него самого", () => {
    // источник: чьё: код (доставка рации на ~email — устройствам x~email)
    expect(reaches("~yuri@example.com", "phone~yuri@example.com")).toBe(true);
    expect(reaches("phone~yuri@example.com", "phone~yuri@example.com")).toBe(true);
    expect(reaches("~yuri@example.com", "phone~anna@example.com")).toBe(false);
    expect(reaches("phone~yuri@example.com", "pult~yuri@example.com")).toBe(false);
    // окончание адреса — с тильдой: ~ann не доходит до joann
    expect(reaches("~ann@example.com", "phone~joann@example.com")).toBe(false);
    expect(reaches("~ann@example.com", "phone~ann@example.com")).toBe(true);
    // userOf: пользователь адреса — устройство и человек; машина, сессия и служба — нет
    expect(userOf("phone~a@b.c")).toBe("~a@b.c");
    expect(userOf("~a@b.c")).toBe("~a@b.c");
    expect(userOf("@laptop")).toBeNull();
    expect(userOf("site@laptop")).toBeNull();
    expect(userOf(".relay")).toBeNull();
  });

  it("3108 · машина-адресат кадра — по to, иначе callsign, иначе machine", () => {
    // источник: чьё: код (порядок рации: to, затем callsign, затем machine)
    expect(hostOf({ machine: "win", session: "site@win" } as { machine: string })).toBe("win");
    expect(hostOf({ callsign: "site@win" })).toBe("win");
    expect(hostOf({ machine: "pc", callsign: "site@win" })).toBe("win");
    expect(hostOf({ to: "@win", machine: "pc" })).toBe("win");
    expect(hostOf({ to: ".keeper@win" })).toBeNull();
    expect(hostOf({ to: ".push", callsign: "site@win" })).toBeNull();
    expect(hostOf({ callsign: "wiki" })).toBeNull();
    expect(hostOf({})).toBeUndefined();
  });

  it("2095 · приём запроса — одно правило: имя обслуживается, версия совпадает, v обязателен", () => {
    // источник: чьё: код (ядро Host отказывало кадру без v, службы пропускали — итерация 6 ревью свела к одному правилу)
    const provides = { "push.send": 1 };
    expect(accepts({ type: "push.send", v: 1 }, provides)).toBeNull();
    expect(accepts({ type: "push.send" }, provides)).toMatchObject({ word: "contract_mismatch" });
    expect(accepts({ type: "push.send", v: 2 }, provides)).toMatchObject({ word: "contract_mismatch" });
    expect(accepts({ type: "toString", v: 1 }, provides)).toMatchObject({ word: "unknown_request" });
    // причина — словами: имя и обе версии
    expect(accepts({ type: "push.send", v: 2 }, provides)!.why).toBe("push.send — запрошена v2, здесь v1");
    expect(accepts({ type: "push.send" }, provides)!.why).toBe("push.send — запрошена v—, здесь v1");
    expect(accepts({ type: "push.drop", v: 1 }, provides)!.why).toBe("push.drop не обслуживается");
  });

  it("2005 · голое имя и обрубки — не адрес", () => {
    // источник: слово пользователя «голых имён нет»
    for (const bad of ["phone", "", ".", "x@", "~", "a~", ".@w", ".k@", 5]) expect(kindOf(bad)).toBeNull();
    expect(machineOf("phone")).toBeNull();
    expect(machineOf("x@")).toBeNull();
  });

  it("5181 · within: значение до предела — оно; после предела — исключение со словами; предел по умолчанию — 120 с", async () => {
    // источник: слово пользователя 2 нояб.: у всех операций лимит; отчёт слепого архитектора 2 нояб.: п. 8 — одна реализация предела
    expect(CALL_MS).toBe(120_000);
    expect(await within(Promise.resolve(7), "не дождался", 50)).toBe(7);
    expect(await within(3, "не дождался", 50)).toBe(3);
    await expect(within(new Promise(() => {}), "gate не ответил за 0,05 с", 50)).rejects.toThrow("gate не ответил за 0,05 с");
  });
});

describe("protocol: предел операции", () => {
  it("7286 · успела: её ответ; нет: ответ late; late бросил: отказ", async () => {
    vi.useFakeTimers();
    await expect(withLimit(Promise.resolve(1), 10, () => 2)).resolves.toBe(1);
    const never = new Promise<number>(() => {});
    const late = withLimit(never, 10, () => 2);
    const refused = withLimit(never, 10, () => {
      throw new Error("долго");
    });
    const seen = expect(refused).rejects.toThrow("долго");
    await vi.advanceTimersByTimeAsync(10);
    await expect(late).resolves.toBe(2);
    await seen;
    vi.useRealTimers();
  });
});
