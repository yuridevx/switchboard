// Эталоны службы файлов (дизайн «Файлы сессии», 1–2; сайты — у службы сайтов): номер эталона — номер теста.
import { describe, expect, it } from "vitest";
import { stand } from "../../test/stand.ts";
import { link } from "../r2.ts";

const A = "a".repeat(64), B = "b".repeat(64);

/** Содержимое в хранилище флота — так, как его кладёт загрузка по ссылке. */
const stored = (s: ReturnType<typeof stand>, hash: string, body: string) => s.env.FILES.put(`files/${s.fleet}/${hash}`, body);

describe("вход хранилища по ссылкам", () => {
  // чьё: код — без настройки ссылка ведёт на вход R2 учётной записи; настройка — дизайн «Проверка всех систем»
  it("адрес входа — настройка: не задана — вход R2 учётной записи; задана — ссылка ведёт на неё, бакет, ключ и подпись на месте", async () => {
    const s = stand();
    const own = new URL(await link(s.env, "PUT", "files/f/a b"));
    expect(own.origin).toBe("https://acc.r2.cloudflarestorage.com");
    const other = new URL(await link({ ...s.env, R2_ENDPOINT: "http://127.0.0.1:4100/" }, "PUT", "files/f/a b"));
    expect(other.origin).toBe("http://127.0.0.1:4100");
    expect(other.pathname).toBe(own.pathname);
    expect(other.pathname).toBe("/sb2-files/files/f/a%20b");
    expect(other.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
    // подпись покрывает адрес входа: у другого входа она другая
    expect(other.searchParams.get("X-Amz-Signature")).not.toBe(own.searchParams.get("X-Amz-Signature"));
  });
});

describe("файлы", () => {
  it("эталон 1 · загрузка: хэша в хранилище нет — ссылка на загрузку; есть — ссылки нет", async () => {
    const s = stand();
    await stored(s, B, "уже лежит");
    const r = (await s.ask("files.put", { files: [{ hash: A, size: 5 }, { hash: B, size: 9 }] }, "kanya1")).result as { upload: Record<string, string> };
    expect(Object.keys(r.upload)).toEqual([A]);
    expect(r.upload[A]).toContain(`/sb2-files/files/${s.fleet}/${A}?`);
    expect(r.upload[A]).toContain("X-Amz-Signature=");
    // не хэш — ввод не по схеме: в хранилище под чужим именем ничего не ляжет
    expect(await s.ask("files.put", { files: [{ hash: "../x", size: 1 }] })).toMatchObject({ ok: false, error: "bad_input" });
  });

  it("эталон 2 · чтение по хэшу с именем: ссылка отдаёт файл вложением с этим именем; хэша нет — no_file", async () => {
    const s = stand();
    await stored(s, A, "отчёт");
    const plain = ((await s.ask("files.get", { hash: A }, "kanya1")).result as { url: string }).url;
    expect(plain).toContain(`/sb2-files/files/${s.fleet}/${A}?`);
    expect(new URL(plain).searchParams.has("response-content-disposition")).toBe(false);
    const named = new URL(((await s.ask("files.get", { hash: A, name: "отчёт.zip" })).result as { url: string }).url);
    expect(named.searchParams.get("response-content-disposition")).toBe(`attachment; filename*=UTF-8''${encodeURIComponent("отчёт.zip")}`);
    expect(named.searchParams.has("X-Amz-Signature")).toBe(true);
    expect(await s.ask("files.get", { hash: B })).toMatchObject({ ok: false, error: "no_file" });
    // содержимое у флота своё: тот же хэш в другом флоте не читается
    expect(await stand().ask("files.get", { hash: A })).toMatchObject({ ok: false, error: "no_file" });
  });
});
