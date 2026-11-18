// Эталоны службы файлов (дизайн «Файлы сессии», 1–4): номер эталона — номер теста.
import { describe, expect, it } from "vitest";
import { stand } from "../../test/stand.ts";
import { link } from "../r2.ts";

const A = "a".repeat(64), B = "b".repeat(64), C = "c".repeat(64);
const SITE = "3f9a1c7e5b2d4f608a1c3e5f7b9d0c2e";
const SANDBOX = "sandbox allow-scripts allow-forms allow-popups";

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

  it("эталон 3 · сайт: /s/номер/ отдаёт index.html, путь из списка — файл с типом по расширению; заголовок песочницы на каждом ответе", async () => {
    const s = stand();
    await stored(s, A, "<h1>Отчёт</h1>");
    await stored(s, B, "h1 { color: teal }");
    await stored(s, C, "console.log(1)");
    const files = [{ path: "index.html", hash: A, size: 14 }, { path: "site.css", hash: B, size: 18 }, { path: "js/app.js", hash: C, size: 14 }];
    // список сайта записывает только машина
    expect(await s.ask("files.site", { site: SITE, files }, "kyura1")).toMatchObject({ ok: false, error: "forbidden" });
    expect((await s.ask("files.site", { site: SITE, files }, "klaptop")).result).toEqual({ url: `https://fleet.test/s/${SITE}/` });

    const index = await s.http(`/s/${SITE}/`);
    expect(index.status).toBe(200);
    expect(index.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(index.headers.get("etag")).toBe(`"${A}"`);
    expect(await index.text()).toBe("<h1>Отчёт</h1>");
    const css = await s.http(`/s/${SITE}/site.css`);
    expect(css.headers.get("content-type")).toBe("text/css; charset=utf-8");
    expect(await css.text()).toBe("h1 { color: teal }");
    const js = await s.http(`/s/${SITE}/js/app.js`);
    expect(js.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    await js.arrayBuffer();
    // без косой черты — переход на адрес сайта; то же содержимое по отпечатку второй раз не идёт
    const bare = await s.http(`/s/${SITE}`, { redirect: "manual" });
    expect([bare.status, bare.headers.get("location")]).toEqual([301, `/s/${SITE}/`]);
    const same = await s.http(`/s/${SITE}/site.css`, { headers: { "if-none-match": `"${B}"` } });
    expect(same.status).toBe(304);
    for (const r of [index, css, js, bare, same]) {
      expect(r.headers.get("content-security-policy")).toBe(SANDBOX);
      expect(r.headers.get("access-control-allow-origin")).toBe("*");
      // содержимое сайта по пути не меняет никто: отпечаток файла — его хэш
      expect(r.headers.get("cache-control")).toBe("no-cache, no-transform");
    }
    // повторная запись заменяет список: путь, которого в нём больше нет, не отдаётся
    await s.ask("files.site", { site: SITE, files: files.slice(0, 2) }, "klaptop");
    const dropped = await s.http(`/s/${SITE}/js/app.js`);
    expect(dropped.status).toBe(404);
    await dropped.text();
  });

  it("эталон 4 · сайт: пути нет в списке, номера сайта нет — 404", async () => {
    const s = stand();
    await stored(s, A, "<h1>Отчёт</h1>");
    await s.ask("files.site", { site: SITE, files: [{ path: "index.html", hash: A, size: 14 }] }, "klaptop");
    for (const path of [`/s/${SITE}/nope.css`, `/s/${"0".repeat(32)}/`, `/s/${SITE}/%E0%A4%A`, "/s/кто-то/"]) {
      const r = await s.http(path);
      expect([path, r.status]).toEqual([path, 404]);
      expect(r.headers.get("content-security-policy")).toBe(SANDBOX);
      await r.text();
    }
  });
});
