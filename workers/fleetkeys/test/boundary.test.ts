// Леса границы «ключи флота», сторона Worker'а. Снаружи: gate и relay. Вход — POST кадра с пропуском; исход — ответ, строка базы, кадры машинам, журнал.
// Адрес участника даёт поддельный gate: пропуск и есть адрес. Источник свойств — договор дизайна «Сессии из кусочков», слово пользователя 5 нояб.: ключ заводится один раз на все машины.
import { applyD1Migrations, env, type D1Migration } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index.ts";

const DB = (env as unknown as { DB: D1Database }).DB;
const MIGRATIONS = (env as unknown as { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS;

const PULT = "pult~a@example.com";
const MACHINE = "@laptop";
const SESSION = "site@laptop";
const SECRET = "sk-test-значение";

type Answer = { type: string; id: string; ok: boolean; error?: string; to?: string; result?: Record<string, unknown> };
type Sent = { type: string; from: string; name: string; v: number };

let sent: Sent[] = [];
let relayDown = false;
const stubs = {
  GATE: {
    verify: async (key: string) => ({ role: "client", name: "стенд", kid: "k1", addr: key }),
  },
  RELAY: {
    broadcast: async (f: Sent) => {
      if (relayDown) throw new Error("relay лежит");
      sent.push(f);
      return 2;
    },
  },
};

let n = 0;
async function ask(from: string, type: string, body: Record<string, unknown> = {}): Promise<Answer> {
  const req = new Request("https://fleetkeys.test/", { method: "POST", body: JSON.stringify({ v: 1, to: ".fleetkeys", id: `r-${++n}`, key: from, type, ...body }) });
  const r = await worker.fetch(req as never, { DB, ...stubs } as never);
  return (await r.json()) as Answer;
}
const set = (o: Record<string, unknown>, from = PULT) => ask(from, "fleetkeys.set", { name: "orca", env: { ANTHROPIC_BASE_URL: "https://api.orcarouter.ai" }, ...o });

beforeEach(async () => {
  await applyD1Migrations(DB, MIGRATIONS);
  await DB.prepare("DELETE FROM keys").run();
  sent = [];
  relayDown = false;
});
afterEach(() => vi.restoreAllMocks());

describe("чтение и запись", () => {
  it("list отдаёт env и settings, значения ключа в ответе нет", async () => {
    expect((await set({ value: SECRET, settings: { modelOverrides: { a: "b" } } })).ok).toBe(true);
    const a = await ask(PULT, "fleetkeys.list");
    expect(a.result).toEqual({ keys: { orca: { env: { ANTHROPIC_BASE_URL: "https://api.orcarouter.ai" }, settings: { modelOverrides: { a: "b" } } } } });
    expect(JSON.stringify(a)).not.toContain(SECRET);
  });

  it("set без value оставляет прежнее значение, меняет env и settings", async () => {
    await set({ value: SECRET });
    expect((await set({ env: { ANTHROPIC_BASE_URL: "https://other" } })).ok).toBe(true);
    const a = await ask(MACHINE, "fleetkeys.key", { name: "orca" });
    expect(a.result).toEqual({ env: { ANTHROPIC_BASE_URL: "https://other" }, settings: {}, key: SECRET });
  });

  it("set с value меняет значение", async () => {
    await set({ value: SECRET });
    await set({ value: "новое" });
    expect((await ask(MACHINE, "fleetkeys.key", { name: "orca" })).result?.key).toBe("новое");
  });

  it("новому ключу без значения — bad_frame, строки нет", async () => {
    expect((await set({})).error).toBe("bad_frame");
    expect((await ask(PULT, "fleetkeys.list")).result).toEqual({ keys: {} });
  });

  it("remove убирает ключ; второй раз — no_key; key на него — no_key", async () => {
    await set({ value: SECRET });
    expect((await ask(PULT, "fleetkeys.remove", { name: "orca" })).ok).toBe(true);
    expect((await ask(PULT, "fleetkeys.remove", { name: "orca" })).error).toBe("no_key");
    expect((await ask(MACHINE, "fleetkeys.key", { name: "orca" })).error).toBe("no_key");
  });
});

describe("кто может", () => {
  it("key только машине: человек и сессия — not_machine, значения в ответе нет", async () => {
    await set({ value: SECRET });
    for (const from of [PULT, SESSION]) {
      const a = await ask(from, "fleetkeys.key", { name: "orca" });
      expect(a.error).toBe("not_machine");
      expect(JSON.stringify(a)).not.toContain(SECRET);
    }
  });

  it("42 · права — мок: машина и сессия ставят и убирают ключ, как человек (слово пользователя 9 нояб.)", async () => {
    for (const from of [MACHINE, SESSION]) {
      expect((await set({ value: SECRET }, from)).ok).toBe(true);
      expect((await ask(MACHINE, "fleetkeys.key", { name: "orca" })).result?.key).toBe(SECRET);
      expect((await ask(from, "fleetkeys.remove", { name: "orca" })).ok).toBe(true);
    }
  });
});

describe("поля", () => {
  it.each(["a/b", "..", "ключ", "", "a b"])("имя с чужими знаками %j — bad_frame: оно становится папкой на машине", async (name) => {
    expect((await set({ name, value: SECRET })).error).toBe("bad_frame");
    expect((await ask(MACHINE, "fleetkeys.key", { name })).error).toBe("bad_frame");
  });

  it("settings не объект и env не строки — bad_frame", async () => {
    expect((await set({ value: SECRET, settings: [1] })).error).toBe("bad_frame");
    expect((await set({ value: SECRET, settings: "x" })).error).toBe("bad_frame");
    expect((await set({ value: SECRET, env: { A: 1 } })).error).toBe("bad_frame");
    expect((await set({ value: SECRET, env: undefined })).error).toBe("bad_frame");
  });

  it("чужой запрос — отказ", async () => {
    expect((await ask(PULT, "fleetkeys.other")).error).toBe("unknown_request");
  });
});

describe("кадр смены ключа", () => {
  it("set и remove шлют fleetkeys.changed каждой машине: без значения ключа, от .fleetkeys", async () => {
    await set({ value: SECRET });
    expect(sent).toEqual([{ type: "fleetkeys.changed", v: 1, from: ".fleetkeys", name: "orca" }]);
    sent = [];
    await ask(PULT, "fleetkeys.remove", { name: "orca" });
    expect(sent.map((f) => f.name)).toEqual(["orca"]);
    expect(JSON.stringify(sent)).not.toContain(SECRET);
  });

  it("отказ кадра не шлёт: нет ключа", async () => {
    await ask(PULT, "fleetkeys.remove", { name: "нет" });
    expect(sent).toEqual([]);
  });

  it("relay не ответил — запись стоит, ответ ok, причина в журнале, значения ключа в журнале нет", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    relayDown = true;
    expect((await set({ value: SECRET })).ok).toBe(true);
    expect((await set({ value: "новое" })).ok).toBe(true);
    expect(sent).toEqual([]);
    const lines = log.mock.calls.flat().join("\n");
    expect(lines).toContain("relay.broadcast");
    expect(lines).not.toContain(SECRET);
    expect(lines).not.toContain("новое");
    expect((await ask(MACHINE, "fleetkeys.key", { name: "orca" })).result?.key).toBe("новое");
  });
});
