// Эталоны службы сайтов (дизайн «Сайты флота», слово пользователя 27 нояб.): номер эталона — номер в дизайне.
import { describe, expect, it } from "vitest";
import { ok, type SessionRow, type Ticket } from "@sb/protocol";
import { type Stand, stand } from "../../test/stand.ts";
import { KIT_LINE } from "./sites/sites.ts";

const A = "a".repeat(64), B = "b".repeat(64), C = "c".repeat(64);
const TAIL = "-t.sites.test";
const CS = "design@laptop";

/** Содержимое в хранилище флота — так, как его кладёт загрузка по ссылке. */
const stored = (s: Stand, hash: string, body: string) => s.env.FILES.put(`files/${s.fleet}/${hash}`, body);
const session = (callsign: string, project?: string): SessionRow => ({ callsign, state: "idle", spec: { name: callsign.split("@")[0]!, cwd: "~", ...(project ? { project } : {}) }, by: "~yuri@example.com", since: 1 });
const FILES = [{ path: "index.html", hash: A, size: 14 }, { path: "site.css", hash: B, size: 18 }, { path: "js/app.js", hash: C, size: 14 }];

/** Флот с проектом «site», сессией design@laptop в нём и содержимым трёх файлов в хранилище. */
async function fleet(): Promise<Stand> {
  const s = stand();
  s.state.sessions = [session(CS, "site"), session("loner@laptop")];
  s.state.fleetAnswer = (f) => (f.type === "people.list" ? ok(f.id!, { people: [], projects: [{ id: "site", name: "Сайт", members: ["~yuri@example.com", "~anya@example.com"] }] }) : ok(f.id!, { called: f.type }));
  await stored(s, A, "<h1>Отчёт</h1>");
  await stored(s, B, "h1 { color: teal }");
  await stored(s, C, "console.log(1)");
  return s;
}
/** Выложить сайт от машины: ответ — адрес. */
const put = async (s: Stand, fields: Record<string, unknown> = {}) => (await s.ask("sites.put", { name: "inbox", callsign: CS, files: FILES, ...fields }, "klaptop")) as { ok: boolean; error?: string; why?: string; result?: { url: string } };
/** Запрос страницы к своему сайту. */
const page = (s: Stand, url: string, path: string, body?: unknown) => s.http(new URL(path, url).href, body === undefined ? undefined : { method: "POST", body: JSON.stringify(body) });
const sql = async (s: Stand, url: string, q: string, ...params: unknown[]) => (await (await page(s, url, "/_sb/db", { sql: q, params })).json()) as { rows?: Record<string, unknown>[]; error?: string; why?: string };

describe("сайты: адрес", () => {
  it("эталон 1 · новое имя: адрес с секретом; файлы уходят байт в байт, в HTML — одна строка панели", async () => {
    const s = await fleet();
    // запись сайта принимает только машина
    expect(await s.ask("sites.put", { name: "inbox", callsign: CS, files: FILES }, "kyura1")).toMatchObject({ ok: false, error: "forbidden" });
    const { url } = (await put(s)).result!;
    expect(url).toMatch(/^https:\/\/inbox-[a-z2-7]{16}-t\.sites\.test\/$/);

    const index = await page(s, url, "/");
    expect([index.status, index.headers.get("content-type"), index.headers.get("etag")]).toEqual([200, "text/html; charset=utf-8", `"${A}-kit"`]);
    expect(await index.text()).toBe("<h1>Отчёт</h1>" + KIT_LINE);
    const css = await page(s, url, "/site.css");
    expect([css.headers.get("content-type"), css.headers.get("etag"), await css.text()]).toEqual(["text/css; charset=utf-8", `"${B}"`, "h1 { color: teal }"]);
    const js = await page(s, url, "/js/app.js");
    expect([js.headers.get("content-type"), await js.text()]).toEqual(["text/javascript; charset=utf-8", "console.log(1)"]);
    // то же содержимое по отпечатку второй раз не идёт
    const same = await s.http(new URL("/site.css", url).href, { headers: { "if-none-match": `"${B}"` } });
    expect(same.status).toBe(304);
    for (const r of [index, css, js, same]) {
      // сайт живёт на своём адресе: песочницы браузера нет; содержимое по пути не меняет никто
      expect(r.headers.get("content-security-policy")).toBeNull();
      expect(r.headers.get("cache-control")).toBe("no-cache, no-transform");
    }
    // пути нет в списке, сайта под адресом нет — 404; прочие пути входа служб на адресе сайта не действуют
    for (const path of ["/nope.css", "/%E0%A4%A", "/health", "/call"]) {
      const r = await page(s, url, path);
      expect([path, r.status]).toEqual([path, 404]);
      await r.text();
    }
    const nobody = await s.http(`https://ghost${TAIL}/`);
    expect(nobody.status).toBe(404);
    await nobody.text();
    // адрес не сайта идёт по входу служб как раньше
    expect(((await (await s.http("/health")).json()) as { modules: string[] }).modules).toContain("sites");
  });

  it("эталон 2 · то же имя: адрес тот же, запись заменяется целиком — пути, которого в ней больше нет, сайт не отдаёт", async () => {
    const s = await fleet();
    const { url } = (await put(s)).result!;
    // выкладывает другая сессия флота — сайт тот же
    expect((await put(s, { callsign: "loner@laptop", files: FILES.slice(0, 2) })).result).toEqual({ url });
    const dropped = await page(s, url, "/js/app.js");
    expect(dropped.status).toBe(404);
    await dropped.text();
    expect((await page(s, url, "/site.css")).status).toBe(200);
  });

  it("эталон 3 · удаление: адрес отвечает 404, база пуста, имя свободно", async () => {
    const s = await fleet();
    const { url } = (await put(s)).result!;
    await sql(s, url, "CREATE TABLE votes (n INTEGER)");
    await sql(s, url, "INSERT INTO votes VALUES (1)");
    expect((await s.ask("site.remove", { name: "inbox" }, "klaptop", CS)).result).toEqual({ removed: true });
    const gone = await page(s, url, "/");
    expect(gone.status).toBe(404);
    await gone.text();
    expect(await s.ask("site.remove", { name: "inbox" })).toMatchObject({ ok: false, error: "no_site" });
    expect(await s.ask("site.db", { name: "inbox", sql: "SELECT 1" })).toMatchObject({ ok: false, error: "no_site" });
    // имя свободно: новый сайт под ним получает новый адрес и пустую базу
    const again = (await put(s)).result!.url;
    expect(again).not.toBe(url);
    expect(await sql(s, again, "SELECT name FROM sqlite_master WHERE name = 'votes'")).toEqual({ rows: [] });
  });

  // чьё: код — содержимое и записи у флота свои (эталоны службы файлов)
  it("эталон 4 · чужой флот: то же имя — другой сайт; чужой сайт по имени не удалить и в его базу не попасть", async () => {
    const mine = await fleet(), other = await fleet();
    const url = (await put(mine)).result!.url;
    expect(await other.ask("site.remove", { name: "inbox" })).toMatchObject({ ok: false, error: "no_site" });
    expect(await other.ask("site.db", { name: "inbox", sql: "SELECT 1" })).toMatchObject({ ok: false, error: "no_site" });
    const theirs = (await put(other)).result!.url;
    expect(theirs).not.toBe(url);
    await sql(other, theirs, "CREATE TABLE only_theirs (n INTEGER)");
    expect(await sql(mine, url, "SELECT name FROM sqlite_master WHERE name = 'only_theirs'")).toEqual({ rows: [] });
    expect((await page(mine, url, "/")).status).toBe(200);
  });

  it("эталон 10 · ручной адрес: свободен — сайт на нём; занят — отказ, чужой сайт цел; у выложенного сайта адрес не меняется", async () => {
    const s = await fleet(), other = await fleet();
    expect((await put(s, { address: "inbox" })).result).toEqual({ url: `https://inbox${TAIL}/` });
    expect((await page(s, `https://inbox${TAIL}/`, "/site.css")).status).toBe(200);
    // занят сайтом своего флота под другим именем и сайтом чужого флота
    expect(await put(s, { name: "second", address: "inbox" })).toMatchObject({ ok: false, error: "taken" });
    expect(await put(other, { name: "theirs", address: "inbox", files: [] })).toMatchObject({ ok: false, error: "taken" });
    expect(await (await page(s, `https://inbox${TAIL}/`, "/site.css")).text()).toBe("h1 { color: teal }");
    // повторная выкладка с тем же адресом — обновление; с другим — отказ
    expect((await put(s, { address: "inbox" })).ok).toBe(true);
    expect(await put(s, { address: "other" })).toMatchObject({ ok: false, error: "bad_input" });
    // адрес не по форме имени узла — ввод не по схеме
    expect(await put(s, { name: "x", address: "a.b" })).toMatchObject({ ok: false, error: "bad_input" });
  });

  it("у флота нет адреса сайтов — выкладка отказывает словом", async () => {
    const s = stand(undefined, { env: { SITES_HOST: undefined } });
    expect(await s.ask("sites.put", { name: "inbox", callsign: CS, files: [] }, "klaptop")).toMatchObject({ ok: false, error: "no_sites" });
  });
});

describe("сайты: база и панель", () => {
  it("эталон 5 · одна база: строку сессии читает страница, строку страницы — сессия; ошибка SQL — отказ словом", async () => {
    const s = await fleet();
    const { url } = (await put(s)).result!;
    const asSession = (q: string, params?: unknown[]) => s.ask("site.db", { name: "inbox", sql: q, ...(params ? { params } : {}) }, "klaptop", CS);
    expect((await asSession("CREATE TABLE votes (day TEXT, n INTEGER)")).ok).toBe(true);
    expect((await asSession("INSERT INTO votes VALUES (?, ?)", ["2026-11-27", 3])).ok).toBe(true);
    expect(await sql(s, url, "SELECT * FROM votes WHERE day = ?", "2026-11-27")).toEqual({ rows: [{ day: "2026-11-27", n: 3 }] });
    await sql(s, url, "INSERT INTO votes VALUES (?, ?)", "2026-11-28", 5);
    expect((await asSession("SELECT n FROM votes ORDER BY day")).result).toEqual({ rows: [{ n: 3 }, { n: 5 }] });
    // таблицы панели есть в базе каждого сайта
    expect((await asSession("SELECT count(*) AS n FROM sb_comments")).result).toEqual({ rows: [{ n: 0 }] });
    expect(await asSession("SELEC nope")).toMatchObject({ ok: false, error: "bad_sql" });
    expect(await sql(s, url, "SELEC nope")).toMatchObject({ error: "bad_sql" });
    const bad = await page(s, url, "/_sb/db", { params: [] });
    expect([bad.status, ((await bad.json()) as { error: string }).error]).toEqual([400, "bad_input"]);
  });

  it("скрипт панели: настройки сайта стоят перед ним; выключатели и коммит идут как записаны", async () => {
    const s = await fleet();
    const kit = { fetch: async () => new Response("/* панель */") } as unknown as Fetcher;
    const withKit = stand(s.fleet, { env: { ASSETS: kit } });
    const { url } = (await put(s, { marks: false, commit: "a1b2c3d", dirty: true })).result!;
    const got = await withKit.http(new URL("/_sb/kit.js", url).href);
    expect(got.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(await got.text()).toBe(`window.sbSite={"name":"inbox","comments":true,"marks":false,"commit":"a1b2c3d","dirty":true};\n/* панель */`);
    // сборка без файлов страницы скрипт не отдаёт
    const none = await page(s, url, "/_sb/kit.js");
    expect(none.status).toBe(404);
    await none.text();
  });

  it("эталон 8 · отправить: 3 черновика — один тикет с 3 пунктами исполнителю из выкладки, строки помечены его номером; черновиков нет — тикета нет", async () => {
    const s = await fleet();
    const { url } = (await put(s, { commit: "a1b2c3d" })).result!;
    const add = (block: string, label: string, text: string, quote: string | null = null) => sql(s, url, "INSERT INTO sb_comments (block, el, label, quote, text, at) VALUES (?, '0/1', ?, ?, ?, 1)", block, label, quote, text);
    await add("queue", "Срочный тикет", "А если срочных два — кто первый?", "срочный встаёт впереди старших");
    await add("etalons", "8 · Отправить", "Нет эталона на пустую очередь.");
    await add("", "Шаг 3", "Шаг 3 раньше шага 2.");
    const sent = (await (await page(s, url, "/_sb/submit", {})).json()) as { ticket: string; comments: number };
    expect(sent).toEqual({ ticket: "site-1", comments: 3 });
    const t = ((await s.ask("ticket.list", { ticket: "site-1" })).result as { tickets: Ticket[] }).tickets[0]!;
    // исполнитель не назван — сессия, которая выложила сайт; автор — служба сайтов
    expect(t).toMatchObject({ id: "site-1", title: "Комментарии к сайту inbox · 3", to: CS, by: ".sites" });
    expect(t.text).toBe(
      `${url} · коммит a1b2c3d\n\n` +
        "1. Блок «queue» · элемент «Срочный тикет»\n   > срочный встаёт впереди старших\n   А если срочных два — кто первый?\n\n" +
        "2. Блок «etalons» · элемент «8 · Отправить»\n   Нет эталона на пустую очередь.\n\n" +
        "3. Блок «страница» · элемент «Шаг 3»\n   Шаг 3 раньше шага 2.",
    );
    expect(await sql(s, url, "SELECT DISTINCT ticket FROM sb_comments")).toEqual({ rows: [{ ticket: "site-1" }] });
    // второй раз отправлять нечего
    expect(await (await page(s, url, "/_sb/submit", {})).json()).toEqual({ ticket: null, comments: 0 });
    expect(((await s.ask("ticket.list", { project: "site" })).result as { tickets: Ticket[] }).tickets).toHaveLength(1);
  });

  it("отправить: сайт сессии без проекта и сайт с выключенными комментариями тикета не заводят — черновики остаются", async () => {
    const s = await fleet();
    const lone = (await put(s, { name: "lone", callsign: "loner@laptop" })).result!.url;
    await sql(s, lone, "INSERT INTO sb_comments (block, el, label, text, at) VALUES ('a', '', 'x', 'y', 1)");
    const no = await page(s, lone, "/_sb/submit", {});
    expect([no.status, ((await no.json()) as { error: string }).error]).toEqual([400, "no_project"]);
    expect(await sql(s, lone, "SELECT ticket FROM sb_comments")).toEqual({ rows: [{ ticket: null }] });
    const quiet = (await put(s, { name: "quiet", comments: false })).result!.url;
    const off = await page(s, quiet, "/_sb/submit", {});
    expect(off.status).toBe(404);
    await off.text();
  });
});
