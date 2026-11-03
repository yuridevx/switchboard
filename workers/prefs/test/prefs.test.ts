import { applyD1Migrations, env, type D1Migration } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { Frame } from "@switchboard/protocol";
import { frame } from "../src/prefs.ts";
import type { Env } from "../src/env.ts";

const E = env as unknown as Env & { TEST_MIGRATIONS: D1Migration[] };
const worker = (exports as unknown as { default: { fetch(r: Request): Promise<Response> } }).default;

const PHONE = "phone~a@example.com";
const PULT = "pult~a@example.com";
const OTHER = "phone~b@example.com";
let n = 0;
/** Запрос от адреса from — как после входа Worker'а; ответ — один кадр. */
const ask = async (from: string, body: Record<string, unknown>) => (await frame(E, { v: 1, to: ".prefs", id: `r-${++n}`, from, ...body } as unknown as Frame))[0] as Frame & { ok: boolean; error?: string; result?: { values: Record<string, unknown> } };
const get = (from: string) => ask(from, { type: "prefs.get" });
const set = (from: string, name: string, value: unknown) => ask(from, { type: "prefs.set", name, value });

beforeEach(async () => {
  await applyD1Migrations(E.DB, E.TEST_MIGRATIONS);
  await E.DB.prepare("DELETE FROM prefs").run();
});

describe("эталоны prefs", () => {
  it("5600 · prefs.get — все ключи одним ответом; ключа нет — его нет в ответе; устройства одного пользователя видят одно", async () => {
    expect((await get(PHONE)).result).toEqual({ values: {} });
    expect((await set(PHONE, "web-board.top", ["switchboard"])).ok).toBe(true);
    expect((await set(PULT, "web-board.pins", ["a@b"])).ok).toBe(true);
    expect((await get(PULT)).result).toEqual({ values: { "web-board.top": ["switchboard"], "web-board.pins": ["a@b"] } });
  });

  it("5601 · запись по ключу целиком: последняя побеждает, другие ключи не трогает", async () => {
    await set(PHONE, "k", { x: 1 });
    await set(PHONE, "other", 1);
    await set(PULT, "k", { y: 2 });
    expect((await get(PHONE)).result?.values).toEqual({ k: { y: 2 }, other: 1 });
  });

  it("5602 · чужая почта: чужих ключей не прочитать и не записать — пользователь только из адреса отправителя", async () => {
    await set(PHONE, "k", "моё");
    expect((await get(OTHER)).result).toEqual({ values: {} });
    await set(OTHER, "k", "чужое");
    expect((await get(PHONE)).result?.values).toEqual({ k: "моё" });
    expect((await get(OTHER)).result?.values).toEqual({ k: "чужое" });
    // поле user в кадре ничего не значит
    await ask(OTHER, { type: "prefs.set", name: "k", value: "подмена", user: "~a@example.com" });
    expect((await get(PHONE)).result?.values).toEqual({ k: "моё" });
  });

  it("5603 · отправитель не человек — отказ словом, строки нет", async () => {
    for (const from of ["@laptop", "site@laptop", ".relay"]) {
      expect(await set(from, "k", 1)).toMatchObject({ ok: false, error: "not_user", to: from });
      expect(await get(from)).toMatchObject({ ok: false, error: "not_user" });
    }
    expect((await E.DB.prepare("SELECT COUNT(*) AS n FROM prefs").first<{ n: number }>())?.n).toBe(0);
  });

  it("5604 · неверные поля — bad_frame; чужой запрос и версия — слово протокола", async () => {
    expect(await set(PHONE, "", 1)).toMatchObject({ ok: false, error: "bad_frame" });
    expect(await ask(PHONE, { type: "prefs.set", name: "k" })).toMatchObject({ ok: false, error: "bad_frame" });
    expect(await ask(PHONE, { type: "prefs.drop" })).toMatchObject({ ok: false, error: "unknown_request" });
    expect(await ask(PHONE, { type: "prefs.get", v: 9 })).toMatchObject({ ok: false, error: "contract_mismatch" });
  });

  it("5605 · вход Worker'а: POST с пропуском; адрес — от gate, не из тела; плохой пропуск — отказ", async () => {
    const post = async (body: unknown) => (await worker.fetch(new Request("https://prefs.test/", { method: "POST", body: JSON.stringify(body) }))).json() as Promise<Record<string, any>>;
    const base = { v: 1, to: ".prefs" };
    expect(await post({ ...base, type: "prefs.get", id: "a", key: "client.phone.k1.bad" })).toMatchObject({ ok: false, error: "bad_key" });
    // from в теле не считается: пользователь стенда — test@example.com
    expect(await post({ ...base, type: "prefs.set", id: "b", key: "client.phone.k1.s", name: "n", value: 7, from: "phone~a@example.com" })).toMatchObject({ ok: true });
    expect((await post({ ...base, type: "prefs.get", id: "c", key: "client.pult.k2.s" })).result).toEqual({ values: { n: 7 } });
    expect((await get(PHONE)).result).toEqual({ values: {} });
    // пропуск машины — отказ словом
    expect(await post({ ...base, type: "prefs.get", id: "d", key: "host.win.k3.s" })).toMatchObject({ ok: false, error: "not_user" });
  });
});
