// Эталоны панели сайта (дизайн «Сайты флота», слово пользователя 27 нояб.): скрипт public/_sb/kit.js на странице с поддельной базой сайта.
// Номер эталона — номер в дизайне: 6 — клавиша C, 7 — клавиша A и выключатели.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";

// тесты страницы идут из папки web
const CODE = readFileSync(join(process.cwd(), "public", "_sb", "kit.js"), "utf8");
const PAGE = `
<section id="queue" data-block><h2>Очередь поста</h2><p>срочный встаёт <b data-chg="c1">впереди старших</b></p><input id="field"></section>
<section id="order" data-block><h2>Порядок</h2><p id="step3">Шаг 3</p></section>`;

type Row = Record<string, unknown>;

/** Страница сайта с панелью: поддельная база держит строки комментариев и меток так, как их пишет скрипт. */
async function site(about: Record<string, unknown>, html = PAGE, was: { comments?: Row[]; marks?: Row[] } = {}) {
  const win = new Window({ url: "https://inbox-secret-t.sites.test/" });
  const doc = win.document;
  doc.body.innerHTML = html;
  const base = { comments: [...(was.comments ?? [])], marks: [...(was.marks ?? [])], sent: 0, calls: [] as string[] };
  const fetch = async (path: string, init: { body: string }) => {
    const q = JSON.parse(init.body) as { sql?: string; params?: unknown[] };
    base.calls.push(path === "/_sb/db" ? q.sql! : path);
    const p = q.params ?? [];
    let rows: Row[] = [];
    if (path === "/_sb/submit") {
      const drafts = base.comments.filter((c) => !c.ticket);
      for (const c of drafts) c.ticket = "site-1";
      base.sent++;
      return { json: async () => ({ ticket: drafts.length ? "site-1" : null, comments: drafts.length }) };
    }
    if (/^SELECT block, seen FROM sb_marks/.test(q.sql!)) rows = base.marks;
    else if (/^SELECT id, block, el, label, quote, text, ticket, reply FROM sb_comments/.test(q.sql!)) rows = base.comments;
    else if (/^INSERT INTO sb_comments/.test(q.sql!)) base.comments.push({ id: base.comments.length + 1, block: p[0], el: p[1], label: p[2], quote: p[3], text: p[4], ticket: null, reply: null });
    else if (/^DELETE FROM sb_comments/.test(q.sql!)) base.comments = base.comments.filter((c) => c.id !== p[0]);
    else if (/^INSERT INTO sb_marks/.test(q.sql!)) base.marks = [...base.marks.filter((m) => m.block !== p[0]), { block: p[0], seen: p[1] }];
    else if (/^DELETE FROM sb_marks/.test(q.sql!)) base.marks = base.marks.filter((m) => m.block !== p[0]);
    else return { json: async () => ({ error: "bad_sql", why: "поддельная база такого запроса не знает: " + q.sql }) };
    return { json: async () => ({ rows: rows.map((r) => ({ ...r })) }) };
  };
  (win as unknown as { sbSite: unknown }).sbSite = { name: "inbox", ...about };
  new Function("window", "document", "fetch", "getSelection", "addEventListener", "scrollX", "scrollY", "Element", CODE)(win, doc, fetch, () => win.getSelection(), win.addEventListener.bind(win), 0, 0, win.Element);
  /** Дождаться, пока панель дочитает базу после действия. */
  const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  await settle();
  const key = (code: string, k: string, target: { dispatchEvent(e: unknown): unknown } = doc) => target.dispatchEvent(new win.KeyboardEvent("keydown", { code, key: k, bubbles: true }));
  const over = (id: string) => doc.getElementById(id)!.dispatchEvent(new win.MouseEvent("mouseenter"));
  const click = (node: { dispatchEvent(e: unknown): unknown }) => node.dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true }));
  const $ = <T = any>(sel: string) => doc.querySelector(sel) as unknown as T;
  const all = (sel: string) => [...doc.querySelectorAll(sel)] as unknown as any[];
  return { win, doc, base, key, over, click, settle, $, all };
}

describe("панель сайта: комментарии", () => {
  it("эталон 6 · клавиша C в любой раскладке, нажатие по элементу — комментарий у этого элемента; жив после перезагрузки; в поле ввода клавиша — буква", async () => {
    const s = await site({ comments: true, marks: true });
    // русская раскладка: клавиша та же, буква другая
    s.key("KeyC", "с");
    expect(s.doc.body.classList.contains("sb-c")).toBe(true);
    // нажатие выбирает элемент и до страницы не доходит
    let reached = 0;
    s.$<any>("#step3").addEventListener("click", () => reached++);
    s.click(s.$("#step3"));
    expect(reached).toBe(0);
    expect(s.doc.body.classList.contains("sb-c")).toBe(false);
    const text = s.$<any>(".sb-pop textarea");
    // клавиши C и A в поле ввода — буквы: режим не включается, метка не ставится
    s.over("order");
    s.key("KeyC", "c", text);
    s.key("KeyA", "a", text);
    expect(s.doc.body.classList.contains("sb-c")).toBe(false);
    expect(s.base.marks).toEqual([]);
    text.value = "Шаг 3 раньше шага 2.";
    s.key("Enter", "Enter", text);
    await s.settle();
    expect(s.base.comments).toEqual([{ id: 1, block: "order", el: "#step3", label: "Шаг 3", quote: null, text: "Шаг 3 раньше шага 2.", ticket: null, reply: null }]);
    expect(s.all(".sb-pin").map((p) => [p.textContent, p.classList.contains("sb-sent")])).toEqual([["1", false]]);
    // элемент без id — путь от блока по номерам детей; украинская раскладка — та же клавиша
    s.key("KeyC", "с");
    s.click(s.$("#queue b"));
    s.$<any>(".sb-pop textarea").value = "А если срочных два?";
    s.key("Enter", "Enter", s.$(".sb-pop textarea"));
    await s.settle();
    expect(s.base.comments[1]).toMatchObject({ block: "queue", el: "1/0", label: "впереди старших" });

    // перезагрузка страницы: метки на месте, нажатие по метке открывает текст и обводит элемент
    const again = await site({ comments: true, marks: true }, PAGE, s.base);
    expect(again.all(".sb-pin")).toHaveLength(2);
    again.click(again.all(".sb-pin")[1]);
    expect(again.$<any>(".sb-pop p").textContent).toBe("А если срочных два?");
    expect(again.$<any>("#queue b").classList.contains("sb-hot")).toBe(true);
    // «Отправить» несёт число черновиков; после отправки метки серые с номером тикета, кнопки нет
    const go = again.$<any>(".sb-go");
    expect([go.hidden, go.textContent]).toEqual([false, "Отправить · 2"]);
    again.click(go);
    await again.settle();
    expect(again.base.sent).toBe(1);
    expect(again.all(".sb-pin.sb-sent")).toHaveLength(2);
    expect(again.$<any>(".sb-go").hidden).toBe(true);
  });

  it("ответ сессии виден в метке; черновик удаляется, отправленный — нет", async () => {
    const s = await site({ comments: true, marks: true }, PAGE, { comments: [
      { id: 1, block: "order", el: "#step3", label: "Шаг 3", quote: "Шаг 3", text: "Раньше шага 2", ticket: "site-1", reply: "Поменял местами" },
      { id: 2, block: "queue", el: "", label: "Очередь поста", quote: null, text: "Черновик", ticket: null, reply: null },
    ] });
    s.click(s.all(".sb-pin")[0]);
    expect(s.all(".sb-pop > *").map((x) => x.textContent)).toEqual(["«Шаг 3»", "Раньше шага 2", "↳ Поменял местами", "site-1"]);
    s.click(s.all(".sb-pin")[1]);
    s.click(s.$(".sb-pop button"));
    await s.settle();
    expect(s.base.comments.map((c) => c.id)).toEqual([1]);
  });
});

describe("панель сайта: просмотрено и выключатели", () => {
  it("эталон 7 · клавиша A в любой раскладке: блок просмотрен — фон блока обычный; ещё раз — снято; новая правка — весь блок снова непросмотрен", async () => {
    const s = await site({ comments: true, marks: true });
    const isNew = (id: string) => s.$<any>("#" + id).classList.contains("sb-new");
    // непросмотренный блок помечен целиком
    expect([isNew("queue"), isNew("order")]).toEqual([true, true]);
    s.over("queue");
    s.key("KeyA", "ф");
    await s.settle();
    expect([isNew("queue"), isNew("order")]).toEqual([false, true]);
    expect(s.base.marks).toEqual([{ block: "queue", seen: '["c1"]' }]);
    s.key("KeyA", "a");
    await s.settle();
    expect(isNew("queue")).toBe(true);
    expect(s.base.marks).toEqual([]);

    // после новой выкладки в блоке появилась правка, которой человек не видел: блок снова непросмотрен
    const next = await site({ comments: true, marks: true }, PAGE.replace("<h2>Очередь поста</h2>", `<h2 data-chg="c2">Очередь поста</h2>`), { marks: [{ block: "queue", seen: '["c1"]' }, { block: "order", seen: "[]" }] });
    expect([next.$<any>("#queue").classList.contains("sb-new"), next.$<any>("#order").classList.contains("sb-new")]).toEqual([true, false]);
  });

  it("эталон 7 · выключатели: только метки — комментариев и «Отправить» нет; обе выключены — панели нет, sb.db есть", async () => {
    const marks = await site({ comments: false, marks: true });
    expect(marks.all(".sb-bar button").map((b) => b.textContent)).toEqual(["✓"]);
    marks.key("KeyC", "c");
    expect(marks.doc.body.classList.contains("sb-c")).toBe(false);
    const none = await site({ comments: false, marks: false });
    expect(none.$("#sb-kit")).toBeNull();
    expect(none.all(".sb-new")).toEqual([]);
    none.over("queue");
    none.key("KeyA", "a");
    await none.settle();
    expect(none.base.calls).toEqual([]);
    // функция базы есть на каждом сайте
    const sb = (none.win as unknown as { sb: { db(sql: string, ...p: unknown[]): Promise<Row[]> } }).sb;
    expect(await sb.db("SELECT block, seen FROM sb_marks")).toEqual([]);
    await expect(sb.db("SELEC nope")).rejects.toThrow(/такого запроса не знает/);
  });

  it("страница без размеченных блоков: блок один — вся страница; пальцем — кнопками панели", async () => {
    const s = await site({ comments: true, marks: true, commit: "a1b2c3d", dirty: true }, `<h1 id="t">Отчёт</h1><p>Текст</p>`);
    // правки вне коммита панель называет вместо номера коммита
    expect(s.$<any>(".sb-bar .sb-dim").textContent).toBe("не в коммите");
    const [c, a] = s.all(".sb-bar button");
    s.click(a);
    await s.settle();
    expect(s.base.marks).toEqual([{ block: "", seen: "[]" }]);
    expect(a.classList.contains("sb-on")).toBe(true);
    s.click(c);
    s.click(s.$("#t"));
    s.$<any>(".sb-pop textarea").value = "Заголовок";
    s.key("Enter", "Enter", s.$(".sb-pop textarea"));
    await s.settle();
    expect(s.base.comments[0]).toMatchObject({ block: "", el: "#t", label: "Отчёт" });
  });
});
