// Леса границы «настройки людей и флота», сторона Worker'а prefs. Снаружи: gate. Вход — POST кадра с пропуском; исход — ответ, строка базы, журнал.
// Адрес участника даёт поддельный gate: пропуск и есть адрес; настоящая привязка к стенду gate — в последнем случае. Номер — эталон-источник; без номера — чьё: код.
import { applyD1Migrations, env, type D1Migration } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index.ts";

const DB = (env as unknown as { DB: D1Database }).DB;
const MIGRATIONS = (env as unknown as { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS;
const real = (exports as unknown as { default: { fetch(r: Request): Promise<Response> } }).default;

const PHONE = "phone~a@example.com";
const PULT = "pult~a@example.com";
const OTHER = "phone~b@example.com";
const MACHINE = "@laptop";
const SESSION = "site@laptop";

const gate = { verify: async (key: string) => ({ role: "client", name: "стенд", kid: "k1", addr: key }) };
const request = (body: unknown) => new Request("https://prefs.test/", { method: "POST", body: JSON.stringify(body) });

type Answer = { type: string; id: string; ok: boolean; error?: string; to?: string; result?: { values: Record<string, unknown> } };
let n = 0;
/** Кадр от адреса from: поля протокола стоят, тест задаёт остальное. */
async function ask(from: string, body: Record<string, unknown>): Promise<Answer> {
  const r = await worker.fetch(request({ v: 1, to: ".prefs", id: `r-${++n}`, key: from, ...body }) as never, { DB, GATE: gate } as never, {} as never);
  return (await r.json()) as Answer;
}
const get = (from: string, o: Record<string, unknown> = {}) => ask(from, { type: "prefs.get", ...o });
const set = (from: string, name: unknown, value: unknown, o: Record<string, unknown> = {}) => ask(from, { type: "prefs.set", name, value, ...o });
const values = async (from: string, o: Record<string, unknown> = {}) => (await get(from, o)).result?.values;
const rows = async () => (await DB.prepare("SELECT user, key, value FROM prefs ORDER BY user, key").all<{ user: string; key: string; value: string }>()).results;

beforeEach(async () => {
  await applyD1Migrations(DB, MIGRATIONS);
  await DB.prepare("DELETE FROM prefs").run();
});
afterEach(() => vi.restoreAllMocks());

describe("чтение и запись", () => {
  it("5600 · prefs.get — все ключи одним ответом; ключа нет — его нет в ответе; устройства одного человека видят одно", async () => {
    expect((await get(PHONE)).result).toEqual({ values: {} });
    expect((await set(PHONE, "web-board.top", ["switchboard"])).ok).toBe(true);
    expect((await set(PULT, "web-board.pins", ["a@b"])).ok).toBe(true);
    expect(await values(PULT)).toEqual({ "web-board.top": ["switchboard"], "web-board.pins": ["a@b"] });
  });

  it("ответ приходит адресату кадром reply с его id; у записи result нет", async () => {
    const a = await ask(PHONE, { type: "prefs.set", id: "мой", name: "k", value: 1 });
    expect(a).toEqual({ type: "reply", id: "мой", ok: true, to: PHONE });
    expect(await ask(PHONE, { type: "prefs.get", id: "чтение" })).toEqual({ type: "reply", id: "чтение", ok: true, to: PHONE, result: { values: { k: 1 } } });
  });

  it.each([
    ["ноль", 0],
    ["ложь", false],
    ["null", null],
    ["пустая строка", ""],
    ["вложенное", { a: [1, { b: "в" }] }],
  ])("значение служба не читает: %s возвращается как записано", async (_n, value) => {
    expect((await set(PHONE, "k", value)).ok).toBe(true);
    expect(await values(PHONE)).toEqual({ k: value });
  });

  it("5601 · запись по ключу целиком: последняя побеждает, другие ключи не трогает", async () => {
    await set(PHONE, "k", { x: 1 });
    await set(PHONE, "other", 1);
    await set(PULT, "k", { y: 2 });
    expect(await values(PHONE)).toEqual({ k: { y: 2 }, other: 1 });
  });

  it("7320 · prefix: только ключи с этим началом; знаки шаблона буквальны; без него — все", async () => {
    // источник: отчёт слепого архитектора 4 нояб.: страница читает всю область, хотя ей нужны только свои ключи
    await set(PHONE, "web-board.top", 1);
    await set(PHONE, "web-labels.names", 2);
    await set(PHONE, "web_board.top", 3);
    expect(await values(PHONE, { prefix: "web-board." })).toEqual({ "web-board.top": 1 });
    expect(await values(PHONE, { prefix: "web_" })).toEqual({ "web_board.top": 3 });
    expect(await values(PHONE, { prefix: "web%" })).toEqual({});
    expect(await values(PHONE, { prefix: "нет." })).toEqual({});
    expect(Object.keys((await values(PHONE)) ?? {})).toHaveLength(3);
  });

  it("формат базы: строка на ключ, владелец — почта, global или app:<приложение>, значение — JSON", async () => {
    await set(PHONE, "личное", { a: 1 });
    await set(PHONE, "fleet.labels", ["x"], { scope: "global" });
    await set(PHONE, "вид", 7, { scope: "app:pult" });
    expect(await rows()).toEqual([
      { user: "app:pult", key: "вид", value: "7" },
      { user: "global", key: "fleet.labels", value: '["x"]' },
      { user: "~a@example.com", key: "личное", value: '{"a":1}' },
    ]);
  });
});

describe("области", () => {
  it("5602 · чужая почта: чужих ключей не прочитать и не записать — человек только из адреса отправителя", async () => {
    await set(PHONE, "k", "моё");
    expect((await get(OTHER)).result).toEqual({ values: {} });
    await set(OTHER, "k", "чужое");
    expect(await values(PHONE)).toEqual({ k: "моё" });
    expect(await values(OTHER)).toEqual({ k: "чужое" });
    // поле user в кадре ничего не значит
    await set(OTHER, "k", "подмена", { user: "~a@example.com" });
    expect(await values(PHONE)).toEqual({ k: "моё" });
  });

  it("6001 · записанное в одной из трёх областей не видно из двух других; другой человек и другое приложение его не видят", async () => {
    await set(PHONE, "k", "человек");
    await set(PHONE, "k", "флот", { scope: "global" });
    await set(PHONE, "k", "пульт", { scope: "app:pult" });
    expect(await values(PHONE)).toEqual({ k: "человек" });
    expect(await values(PULT, { scope: "global" })).toEqual({ k: "флот" });
    expect(await values(OTHER, { scope: "global" })).toEqual({ k: "флот" });
    expect(await values(OTHER, { scope: "app:pult" })).toEqual({ k: "пульт" });
    expect(await values(PHONE, { scope: "app:phone" })).toEqual({});
    expect(await values(OTHER)).toEqual({});
  });

  it("6002 · машина и сессия читают и пишут область флота; в область человека им нельзя", async () => {
    expect(await set(MACHINE, "fleet.labels", { machines: { laptop: "ПК" } }, { scope: "global" })).toMatchObject({ ok: true });
    expect(await values(SESSION, { scope: "global" })).toEqual({ "fleet.labels": { machines: { laptop: "ПК" } } });
    expect(await get(MACHINE)).toMatchObject({ ok: false, error: "not_user" });
  });
});

describe("отказы словом", () => {
  it.each([MACHINE, SESSION, ".relay"])("5603 · отправитель %s не человек и без области — not_user, строки нет", async (from) => {
    expect(await set(from, "k", 1)).toMatchObject({ ok: false, error: "not_user", to: from });
    expect(await get(from)).toMatchObject({ ok: false, error: "not_user", to: from });
    expect(await rows()).toEqual([]);
  });

  it.each(["~a@example.com", "app:~a@example.com", "app:", "user", 1])("6003 · область %j — bad_frame, чужого не прочесть и не записать", async (scope) => {
    await set(PHONE, "k", "моё");
    expect(await get(OTHER, { scope })).toMatchObject({ ok: false, error: "bad_frame" });
    expect(await set(OTHER, "k", "чужое", { scope })).toMatchObject({ ok: false, error: "bad_frame" });
    expect(await values(PHONE)).toEqual({ k: "моё" });
    expect(await rows()).toHaveLength(1);
  });

  it("6004 · значение больше предела — too_large, строки нет; ровно предел записывается", async () => {
    expect(await set(PHONE, "big", "x".repeat(2_000_001), { scope: "global" })).toMatchObject({ ok: false, error: "too_large" });
    expect(await values(PHONE, { scope: "global" })).toEqual({});
    // JSON строки — на две кавычки длиннее
    expect(await set(PHONE, "fits", "x".repeat(1_999_998), { scope: "global" })).toMatchObject({ ok: true });
    expect(await set(PHONE, "over", "x".repeat(1_999_999), { scope: "global" })).toMatchObject({ ok: false, error: "too_large" });
  });

  it.each<[string, Record<string, unknown>, string]>([
    ["пустое имя", { type: "prefs.set", name: "", value: 1 }, "bad_frame"],
    ["имя не строка", { type: "prefs.set", name: 7, value: 1 }, "bad_frame"],
    ["нет значения", { type: "prefs.set", name: "k" }, "bad_frame"],
    ["пустой prefix (7320)", { type: "prefs.get", prefix: "" }, "bad_frame"],
    ["prefix не строка", { type: "prefs.get", prefix: 1 }, "bad_frame"],
    ["чужой запрос", { type: "prefs.drop" }, "unknown_request"],
    ["чужая версия", { type: "prefs.get", v: 9 }, "contract_mismatch"],
  ])("5604 · %s — отказ словом", async (_n, body, word) => {
    expect(await ask(PHONE, body)).toMatchObject({ ok: false, error: word, to: PHONE });
    expect(await rows()).toEqual([]);
  });

  it("кадр без id: ответить некому, тело пустое, строки нет, причина в журнале", async () => {
    const lines = journal();
    const r = await worker.fetch(request({ v: 1, to: ".prefs", type: "prefs.set", name: "k", value: 1, key: PHONE }) as never, { DB, GATE: gate } as never, {} as never);
    expect(r.status).toBe(204);
    expect(await rows()).toEqual([]);
    expect(lines.at(-1)).toMatchObject({ part: "prefs", kind: "refuse", ev: "prefs.set", word: "bad_frame", from: PHONE });
    expect(String(lines.at(-1)?.why)).toContain("без id");
  });

  it("журнал отказа: слово, отправитель и причина; значения настройки в нём нет", async () => {
    const lines = journal();
    const secret = `секрет${"x".repeat(2_000_000)}`;
    await set(PHONE, "big", secret);
    await set(MACHINE, "k", "секрет-машины");
    expect(lines[0]).toMatchObject({ part: "prefs", kind: "refuse", ev: "prefs.set", word: "too_large", from: PHONE });
    expect(lines[0].why).toBe(`big: ${JSON.stringify(secret).length} знаков, предел 2000000`);
    expect(lines[1]).toMatchObject({ word: "not_user", from: MACHINE });
    expect(lines[1].why).toBe(`${MACHINE} — не человек и не его устройство`);
    expect(JSON.stringify(lines)).not.toContain("секрет");
    expect(typeof lines[0].t).toBe("string");
  });

  it.each<[string, Record<string, unknown>, string]>([
    ["область", { type: "prefs.get", scope: "user" }, 'область "user": нужно global или app:<приложение>'],
    ["prefix", { type: "prefs.get", prefix: "" }, "prefix — непустая строка"],
    ["имя", { type: "prefs.set", value: 1 }, "в prefs.set нет name"],
    ["значение", { type: "prefs.set", name: "k" }, "в prefs.set k нет value"],
  ])("причина в журнале словами: %s", async (_n, body, why) => {
    const lines = journal();
    await ask(PHONE, body);
    expect(lines.at(-1)?.why).toBe(why);
  });
});

describe("вход Worker'а", () => {
  it("5605 · POST с пропуском через настоящую привязку gate: адрес — от gate, не из тела; плохой пропуск и пропуск машины — отказ", async () => {
    const post = async (body: unknown) => (await real.fetch(request(body))).json() as Promise<Record<string, unknown>>;
    const base = { v: 1, to: ".prefs" };
    expect(await post({ ...base, type: "prefs.get", id: "a", key: "client.phone.k1.bad" })).toMatchObject({ ok: false, error: "bad_key" });
    // from в теле не считается: человек стенда — test@example.com
    expect(await post({ ...base, type: "prefs.set", id: "b", key: "client.phone.k1.s", name: "n", value: 7, from: PHONE })).toMatchObject({ ok: true });
    expect(await post({ ...base, type: "prefs.get", id: "c", key: "client.pult.k2.s" })).toMatchObject({ result: { values: { n: 7 } } });
    expect(await values(PHONE)).toEqual({});
    expect(await post({ ...base, type: "prefs.get", id: "d", key: "host.win.k3.s" })).toMatchObject({ ok: false, error: "not_user" });
  });
});

function journal() {
  const lines: Array<Record<string, unknown>> = [];
  vi.spyOn(console, "log").mockImplementation((s: unknown) => {
    const text = String(s);
    if (text.startsWith("{")) lines.push(JSON.parse(text));
  });
  return lines;
}
