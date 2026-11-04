// Рендер текста ответа: разметка, санитайзер, блоки кода. На странице лежит ключ флота: скрипт из ответа сессии до неё дойти не должен.
// То, что исполняет только настоящий браузер (sandbox, CSP, обработчики), — scripts/shots/sandbox.mjs.
import { createRoot, type Root } from "react-dom/client";
import { act, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ItemView } from "../src/cards/ItemView.tsx";
import { CardsCtx, type CardsView } from "../src/context.ts";
import { applyEvents, emptyFeed } from "../src/state/feed.ts";
import type { Feed } from "../src/state/types.ts";
import type { WireMessage } from "../src/state/wire.ts";
import { framed, HtmlFrame } from "@switchboard/web-ui";
import { CodeBlock } from "@switchboard/web-ui";
import { Markdown } from "@switchboard/web-ui";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;

async function draw(node: ReactNode) {
  document.body.innerHTML = '<div id="r"></div>';
  const el = document.getElementById("r")!;
  root = createRoot(el);
  await act(async () => root!.render(node));
  return el;
}
const md = (text: string) => draw(<Markdown text={text} />);
const button = (el: Element, text: string) => [...el.querySelectorAll("button")].find((b) => b.textContent === text);

/** Записи ленты как на экране: свёртка настоящая, карточки настоящие. */
function FeedView({ feed }: { feed: Feed }) {
  const view: CardsView = { useFeed: <T,>(select: (f: Feed) => T) => select(feed), useAsking: () => false, name: "site@laptop", wide: true };
  return (
    <CardsCtx.Provider value={view}>
      {feed.items.map((it) => (
        <ItemView key={it.id} it={it} />
      ))}
    </CardsCtx.Provider>
  );
}
const fold = (msgs: WireMessage[]) => applyEvents(emptyFeed(), msgs);
const asst = (uuid: string, content: unknown[]): WireMessage => ({ type: "assistant", uuid, message: { id: uuid, content: content as never } });

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  vi.restoreAllMocks();
});

describe("разметка", () => {
  it("6220 · заголовки, списки, таблица в прокрутке, задачи, цитата и код", async () => {
    const el = await md("## Итог\n\n- [x] готово\n\n> цитата\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n`код`");
    expect(el.querySelector("h2")!.textContent).toBe("Итог");
    expect(el.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(true);
    expect(el.querySelector("blockquote")).not.toBeNull();
    expect(el.querySelector(".md-table table td")!.textContent).toBe("1");
    expect(el.querySelector("p code")!.textContent).toBe("код");
  });

  it("6221 · ссылка — в новой вкладке без доступа к странице; картинка без реферера, data:image показан", async () => {
    const el = await md('[журнал](https://example.com/ci)\n\n![x](https://example.com/a.png)\n\n<img src="data:image/png;base64,AAA" alt="d">');
    const a = el.querySelector("a")!;
    expect(a.target).toBe("_blank");
    expect(a.rel).toBe("noopener noreferrer");
    const [x, d] = el.querySelectorAll("img");
    expect(x.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(d.getAttribute("src")).toBe("data:image/png;base64,AAA");
  });

  it("6222 · блок кода: язык, подсветка, текст без потерь, «копировать» кладёт код в буфер; неизвестный язык — без подсветки", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    const el = await md("```ts\nconst a = 1;\n```\n\n```brainfuck\n+++\n```");
    const [ts, bf] = el.querySelectorAll(".cb");
    expect(ts.querySelector(".cb-l")!.textContent).toBe("ts");
    expect(ts.querySelector("pre code")!.textContent).toBe("const a = 1;");
    expect(ts.querySelector(".hljs-keyword")!.textContent).toBe("const");
    expect(bf.querySelector("pre code")!.textContent).toBe("+++");
    expect(bf.querySelector("[class^=hljs-]")).toBeNull();
    await act(async () => ts.querySelector<HTMLButtonElement>('[aria-label="Копировать"]')!.click());
    expect(writeText).toHaveBeenCalledWith("const a = 1;");
    vi.unstubAllGlobals();
  });

  it("6728 · сырой pre без code: блок показывает этот текст", async () => {
    const el = await md("<pre>сырой текст</pre>\n\n<pre><b>жирный</b> текст</pre>");
    const pres = el.querySelectorAll("pre");
    expect(pres[0].textContent).toBe("сырой текст");
    expect(pres[1].textContent).toBe("жирный текст");
  });

  it("6729 · сноска: номер ведёт к тексту этой же страницы, цель есть в разметке, новой вкладки и смены адреса нет", async () => {
    const before = location.hash;
    const el = await md("x[^1]\n\n[^1]: текст сноски");
    const ref = el.querySelector<HTMLAnchorElement>("sup a")!;
    const id = ref.getAttribute("href")!.slice(1);
    expect(ref.target).not.toBe("_blank");
    const target = el.querySelector(`[id="${id}"]`);
    expect(target?.textContent).toContain("текст сноски");
    const scroll = vi.fn();
    (target as HTMLElement).scrollIntoView = scroll;
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    await act(async () => ref.dispatchEvent(click));
    expect(click.defaultPrevented).toBe(true);
    expect(scroll).toHaveBeenCalledOnce();
    expect(location.hash).toBe(before);
  });

  it("6733 · буфер недоступен или отказал: галочки нет, экран живой", async () => {
    const copy = async (clipboard: unknown) => {
      vi.stubGlobal("navigator", { ...navigator, clipboard });
      const el = await draw(<CodeBlock code="x" lang="ts" />);
      const b = el.querySelector<HTMLButtonElement>('[aria-label="Копировать"]')!;
      const icon = b.innerHTML;
      await act(async () => b.click());
      expect(b.innerHTML).toBe(icon);
      expect(el.querySelector("pre code")!.textContent).toBe("x");
      await act(async () => root?.unmount());
      vi.unstubAllGlobals();
    };
    await copy(undefined);
    await copy({ writeText: () => Promise.reject(new Error("запрещено")) });
  });

  it("6734 · копировать ответ: оба текста через пустую строку; пишущийся и без текста — кнопки нет", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    const done = await draw(<FeedView feed={fold([asst("a1", [{ type: "text", text: "раз" }, { type: "tool_use", id: "t1", name: "Read", input: {} }, { type: "text", text: "два" }])])} />);
    await act(async () => done.querySelector<HTMLButtonElement>(".chat-acts button")!.click());
    expect(writeText).toHaveBeenCalledWith("раз\n\nдва");
    expect(done.querySelector(".chat-acts")!.textContent).toBe("скопировано");
    await act(async () => root?.unmount());
    vi.unstubAllGlobals();
    const live = fold([
      { type: "stream_event", event: { type: "message_start", message: { id: "m" } } },
      { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "пишется" } } },
    ]);
    expect((await draw(<FeedView feed={live} />)).querySelector(".chat-acts")).toBeNull();
    await act(async () => root?.unmount());
    expect((await draw(<FeedView feed={fold([asst("a2", [{ type: "tool_use", id: "t2", name: "Read", input: {} }])])} />)).querySelector(".chat-acts")).toBeNull();
  });
});

describe("встроенный HTML", () => {
  it("6224 · разрешённая разметка рисуется элементами", async () => {
    const el = await md("<kbd>K</kbd> <mark>метка</mark> H<sub>2</sub>O\n\n<details><summary>Ещё</summary>\n\nтекст\n\n</details>");
    for (const t of ["kbd", "mark", "sub", "details", "summary"]) expect(el.querySelector(t), t).not.toBeNull();
  });

  it("6225 · скрипты, обработчики, стили, iframe и опасные адреса вырезаны; текст внутри остаётся, тело script — нет", async () => {
    const el = await md('<script>window.x=1</script><style>body{display:none}</style><iframe src="https://evil.example"></iframe><img src="x" onerror="window.x=1" alt="a"><a href="javascript:alert(1)" onclick="window.x=1">b</a><div style="position:fixed" onmouseover="window.x=1">c</div><form action="https://evil.example"><input name="k"></form>');
    const html = el.innerHTML;
    for (const bad of ["<script", "<style", "<iframe", "onerror", "onclick", "onmouseover", "javascript:", "position:fixed", "<form", "evil.example", "window.x"]) expect(html, bad).not.toContain(bad);
    expect(el.querySelector("img")!.getAttribute("alt")).toBe("a");
    expect(el.textContent).toContain("c");
  });

  it("6720 · опасный адрес ссылки: у каждой нет href, текст виден", async () => {
    const bad = ["javascript:alert(1)", "JaVaScRiPt:alert(1)", " javascript:alert(1)", "java&#9;script:alert(1)", "vbscript:x", "data:text/html,x", "blob:https://a/b", "file:///etc/passwd"];
    const el = await md([...bad.map((u, i) => `<a href="${u}">r${i}</a>`), "[m](javascript:alert(1))", "[r][1]", "", "[1]: javascript:alert(1)"].join("\n"));
    const links = [...el.querySelectorAll("a")];
    expect(links.map((a) => a.textContent)).toEqual([...bad.map((_, i) => `r${i}`), "m", "r"]);
    for (const a of links) expect(a.hasAttribute("href"), a.textContent ?? "").toBe(false);
  });

  it("6721 · ссылка не задаёт себе окно и реферер: target и rel наши, ping и download нет", async () => {
    const a = (await md('<a href="https://example.com" target="_self" rel="opener" ping="https://evil.example" download>x</a>')).querySelector("a")!;
    expect(a.target).toBe("_blank");
    expect(a.rel).toBe("noopener noreferrer");
    expect(a.hasAttribute("ping")).toBe(false);
    expect(a.hasAttribute("download")).toBe(false);
  });

  it("6722 · ссылка-приглашение и адрес этой страницы с # в ответе: без href, текст виден", async () => {
    const number = "ab12.AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde";
    const here = `${location.origin}${location.pathname}`;
    const bad = [`#invite=${number}`, `#invite%3D${number}`, `#%69nvite=${number}`, `/#invite=${number}`, `?x=1#invite=${number}`, `https://pult.example/#invite=${number}`, "#card?callsign=site%40laptop", `${here}#settings`];
    const el = await md(bad.map((u, i) => `[r${i}](${u})`).join("\n\n"));
    const links = [...el.querySelectorAll("a")];
    expect(links.map((a) => a.textContent)).toEqual(bad.map((_, i) => `r${i}`));
    for (const a of links) expect(a.hasAttribute("href"), a.textContent ?? "").toBe(false);
  });

  it("6723 · опасный адрес картинки: без src, подпись остаётся; referrerpolicy наш, crossorigin нет", async () => {
    const el = await md('<img src="javascript:alert(1)" alt="a"> <img src="data:text/html,x" alt="b"> ![c](javascript:alert(1)) <img src="https://example.com/x.png" referrerpolicy="unsafe-url" crossorigin="use-credentials" alt="d">');
    const [a, b, c, d] = el.querySelectorAll("img");
    for (const x of [a, b, c]) expect(x.hasAttribute("src"), x.alt).toBe(false);
    expect([a.alt, b.alt, c.alt]).toEqual(["a", "b", "c"]);
    expect(d.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(d.hasAttribute("crossorigin")).toBe(false);
  });

  it("6724 · подделка интерфейса: классы, стиль, data и фокус сняты; поля и кнопки вырезаны, их текст остаётся; input — только отключённый флажок", async () => {
    const el = await md('<div class="chat-ban bad" style="position:fixed" data-act="wipe" contenteditable autofocus>шапка</div><input type="password" name="p"><button>Войти</button><textarea>текст</textarea><select><option>o</option></select>');
    const div = [...el.querySelectorAll(".md div")].find((d) => d.textContent?.startsWith("шапка"))!;
    for (const attr of ["class", "style", "data-act", "contenteditable", "autofocus"]) expect(div.hasAttribute(attr), attr).toBe(false);
    for (const t of ["button", "textarea", "select"]) expect(el.querySelector(t), t).toBeNull();
    expect(el.textContent).toContain("Войти");
    expect(el.textContent).toContain("текст");
    for (const i of el.querySelectorAll("input")) {
      expect(i.getAttribute("type")).toBe("checkbox");
      expect(i.disabled).toBe(true);
    }
  });

  it("6725 · подмена имён страницы: id и name с приставкой, document прежний", async () => {
    const body = document.body;
    const cookie = document.cookie;
    const el = await md('<a id="location" name="key" href="https://example.com">a</a> <img id="body" name="cookie" alt="b">');
    expect(el.querySelector("a")!.id).toBe("user-content-location");
    expect(el.querySelector("a")!.getAttribute("name")).toBe("user-content-key");
    expect(el.querySelector("img")!.id).toBe("user-content-body");
    expect(document.body).toBe(body);
    expect(document.cookie).toBe(cookie);
  });

  it("6726 · код не разбирается как HTML: виден как написан, элементов нет", async () => {
    const el = await md("`<script>a()</script>`\n\n```html\n<script>a()</script><b>x</b>\n```\n\n&lt;script&gt;b()&lt;/script&gt; \\<b\\>c\\</b\\>");
    expect(el.querySelector("script")).toBeNull();
    expect(el.querySelector("b")).toBeNull();
    expect(el.querySelector("p code")!.textContent).toBe("<script>a()</script>");
    expect(el.querySelector(".cb pre code")!.textContent).toBe("<script>a()</script><b>x</b>");
    expect(el.textContent).toContain("<script>b()</script>");
    expect(el.textContent).toContain("<b>c</b>");
  });

  it("6727 · язык блока не выходит в разметку: чужой класс снят, негодный язык без подписи и подсветки", async () => {
    const el = await md('```x"><img/src=x/onerror=a()>\nraw\n```\n\n<pre><code class="language-html x" onclick="a()">h</code></pre>\n\n<pre><code class="language-ts chat-ban">t</code></pre>');
    expect(el.querySelector("img")).toBeNull();
    expect(el.innerHTML).not.toContain("onclick");
    expect(el.innerHTML).not.toContain("chat-ban");
    const [neg, html, ts] = el.querySelectorAll(".cb");
    expect(neg.querySelector(".cb-l")!.textContent).toBe("");
    expect(neg.querySelector("pre code")!.textContent).toBe("raw");
    expect(html.querySelector(".cb-l")!.textContent).toBe("html");
    expect(ts.querySelector(".cb-l")!.textContent).toBe("ts");
  });

  it("6730 · теги не выходят за свой блок: всё внутри своего .md, соседние карточки целы", async () => {
    const el = await draw(<FeedView feed={fold([asst("a1", [{ type: "text", text: "до" }]), asst("a2", [{ type: "text", text: "</div></div></div><div>выход</div></details><p>x" }]), asst("a3", [{ type: "text", text: "после" }])])} />);
    const mds = [...el.querySelectorAll(".md")];
    expect(mds).toHaveLength(3);
    expect(mds[1].textContent).toContain("выход");
    expect(mds[0].textContent).toBe("до");
    expect(mds[2].textContent).toBe("после");
    expect(el.querySelectorAll(".chat-reply")).toHaveLength(3);
  });

  it("6731 · каждый вход разметки — через санитайзер: ответ, размышление, план, итог субагента, чужая сессия, сессия владельцу, сводка сжатия", async () => {
    const evil = '<script>window.x=1</script><img src=x onerror="window.x=1"><a href="javascript:alert(1)">z</a>';
    const feed = fold([
      asst("a1", [{ type: "thinking", thinking: evil }, { type: "text", text: evil }]),
      asst("a2", [{ type: "tool_use", id: "p", name: "ExitPlanMode", input: { plan: evil } }]),
      asst("a3", [{ type: "tool_use", id: "s", name: "Agent", input: { description: "d", prompt: "p" } }]),
      { type: "user", uuid: "r", message: { content: [{ type: "tool_result", tool_use_id: "s", content: evil }] as never } },
      { type: "user", uuid: "f", message: { content: `<fleet-message from="a@b">\n${evil}\n</fleet-message>` } },
      { type: "system", subtype: "compact_boundary", uuid: "b", compact_metadata: { pre_tokens: 9000 } },
      { type: "user", uuid: "c", isCompactSummary: true, message: { content: `This session is being continued from a previous conversation.\nSummary:\n${evil}` } },
    ]);
    const withIn: Feed = { ...feed, items: [...feed.items, { kind: "in", id: "i", text: evil, at: 1, push: false }] };
    const el = await draw(<FeedView feed={withIn} />);
    for (const b of [...el.querySelectorAll<HTMLElement>('[aria-expanded="false"]')]) await act(async () => b.click());
    expect(el.querySelectorAll(".md").length).toBeGreaterThanOrEqual(6);
    const html = el.innerHTML;
    for (const bad of ["<script", "onerror", "javascript:", "window.x"]) expect(html, bad).not.toContain(bad);
  });

  it("6732 · опасное приходит кусочками: неполный тег виден текстом, ни на одном шаге нет обработчика и script", async () => {
    const piece = (text: string): WireMessage => ({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text } } });
    let feed = fold([{ type: "stream_event", event: { type: "message_start", message: { id: "m" } } }]);
    const steps = ["<img src=x onerr", 'or="a()">', "<script>a(", ")</script>"];
    const check = async () => {
      const el = await draw(<FeedView feed={feed} />);
      expect(el.innerHTML).not.toContain("onerror=");
      expect(el.querySelector("script")).toBeNull();
      const text = el.textContent;
      await act(async () => root?.unmount());
      return text;
    };
    feed = applyEvents(feed, [piece(steps[0])]);
    expect(await check()).toContain("<img src=x onerr");
    for (const s of steps.slice(1)) {
      feed = applyEvents(feed, [piece(s)]);
      await check();
    }
  });
});

describe("песочница", () => {
  it("6227 · документ в iframe: только allow-scripts; CSP с запретом сети и WebRTC раньше содержимого", async () => {
    const f = (await draw(<HtmlFrame html="<h1>Отчёт</h1>" />)).querySelector("iframe")!;
    expect(f.getAttribute("sandbox")).toBe("allow-scripts");
    const doc = framed("<h1>Отчёт</h1>");
    expect(doc.indexOf("Content-Security-Policy")).toBeLessThan(doc.indexOf("<h1>"));
    expect(doc).toContain("default-src 'none'");
    expect(doc).toContain("webrtc 'block'");
    expect(doc).not.toMatch(/connect-src|https?:/);
  });

  it("6228 · блок html: сначала код; «Просмотр» — песочница; «Код» — обратно", async () => {
    const el = await draw(<CodeBlock code="<b>x</b>" lang="html" />);
    expect(el.querySelector("iframe")).toBeNull();
    await act(async () => button(el, "Просмотр")!.click());
    expect(el.querySelector("iframe")).not.toBeNull();
    await act(async () => button(el, "Код")!.click());
    expect(el.querySelector("iframe")).toBeNull();
  });

  it("6229 · блок другого языка просмотра не предлагает", async () => {
    const el = await md("```xml\n<a/>\n```\n\n```js\nconst s = '<script>';\n```");
    expect(button(el, "Просмотр")).toBeUndefined();
    expect(el.querySelector("iframe")).toBeNull();
  });

  it("6735 · ответ — целый документ: готовый — блок с просмотром; пишущийся — как текст", async () => {
    const doc = "<!doctype html><html><body><h1>д</h1></body></html>";
    const ready = await draw(<FeedView feed={fold([asst("a", [{ type: "text", text: doc }])])} />);
    expect(button(ready, "Просмотр")).toBeDefined();
    await act(async () => root?.unmount());
    const live = fold([
      { type: "stream_event", event: { type: "message_start", message: { id: "m" } } },
      { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: doc } } },
    ]);
    const going = await draw(<FeedView feed={live} />);
    expect(button(going, "Просмотр")).toBeUndefined();
    expect(going.querySelector(".chat-txt")).not.toBeNull();
  });

  it("6736 · запись файла HTML: у .html и .svg страница и дифф; у .md только дифф", async () => {
    const write = (id: string, file_path: string, content: string) => asst(id, [{ type: "tool_use", id: `w-${id}`, name: "Write", input: { file_path, content } }]);
    const el = await draw(<FeedView feed={fold([write("h", "a.html", "<b>x</b>"), write("s", "a.svg", "<svg></svg>"), write("m", "a.md", "# x")])} />);
    const cards = [...el.querySelectorAll<HTMLElement>('[data-tool="Write"]')];
    for (const c of cards) await act(async () => c.querySelector<HTMLElement>(".tc-h")!.click());
    expect(cards.map((c) => !!c.querySelector("iframe"))).toEqual([true, true, false]);
    expect(cards.map((c) => !!c.querySelector(".chat-diff"))).toEqual([true, true, true]);
  });

  it("6739 · запись: документ по содержимому — .htm и .txt с doctype: рамка и дифф", async () => {
    const write = (id: string, file_path: string, content: string) => asst(id, [{ type: "tool_use", id: `w-${id}`, name: "Write", input: { file_path, content } }]);
    const el = await draw(<FeedView feed={fold([write("h", "a.htm", "<b>x</b>"), write("t", "a.txt", "<!doctype html><p>д</p>")])} />);
    const cards = [...el.querySelectorAll<HTMLElement>('[data-tool="Write"]')];
    for (const c of cards) await act(async () => c.querySelector<HTMLElement>(".tc-h")!.click());
    expect(cards.map((c) => !!c.querySelector("iframe") && !!c.querySelector(".chat-diff"))).toEqual([true, true]);
  });

  it("6737 · блок svg и язык заглавными: «Просмотр», документ в рамке", async () => {
    for (const lang of ["svg", "HTML"]) {
      const el = await draw(<CodeBlock code="<b>x</b>" lang={lang} />);
      await act(async () => button(el, "Просмотр")!.click());
      expect(el.querySelector("iframe"), lang).not.toBeNull();
      await act(async () => root?.unmount());
    }
  });

  it("6738 · документ сам не запускается: рамки нет, пока человек не нажал или не раскрыл", async () => {
    const doc = "<!doctype html><script>a()</script>";
    const el = await draw(
      <FeedView
        feed={fold([
          asst("a", [{ type: "text", text: doc }]),
          asst("b", [{ type: "text", text: "```html\n<script>a()</script>\n```" }]),
          asst("c", [{ type: "tool_use", id: "w", name: "Write", input: { file_path: "a.html", content: doc } }]),
        ])}
      />,
    );
    expect(el.querySelector("iframe")).toBeNull();
    await act(async () => el.querySelector<HTMLElement>('[data-tool="Write"] .tc-h')!.click());
    expect(el.querySelectorAll("iframe")).toHaveLength(1);
  });

  it("6740 · документ в сообщении другой сессии и сессии владельцу: только разметка, рамки и «Просмотр» нет", async () => {
    const doc = '<!doctype html><html><body onload="a()"><script>a()</script><h1>д</h1>';
    const feed = fold([{ type: "user", uuid: "f", message: { content: `<fleet-message from="a@b">\n${doc}\n</fleet-message>` } }]);
    const el = await draw(<FeedView feed={{ ...feed, items: [...feed.items, { kind: "in", id: "i", text: doc, at: 1, push: false }] }} />);
    expect(el.querySelector("iframe")).toBeNull();
    expect(button(el, "Просмотр")).toBeUndefined();
    expect(el.querySelectorAll("h1")).toHaveLength(2);
    expect(el.querySelector("script")).toBeNull();
    expect(el.innerHTML).not.toContain("onload");
  });
});
