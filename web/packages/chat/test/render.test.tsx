// Рендер текста ответа: разметка, санитайзер, песочница. На странице лежит ключ флота: скрипт из ответа сессии до неё дойти не должен.
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { framed, HtmlFrame } from "../src/ui/HtmlFrame.tsx";
import { CodeBlock } from "../src/ui/CodeBlock.tsx";
import { Markdown } from "../src/ui/Markdown.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;

async function draw(node: React.ReactNode) {
  document.body.innerHTML = '<div id="r"></div>';
  const el = document.getElementById("r")!;
  root = createRoot(el);
  await act(async () => root!.render(node));
  return el;
}
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
});

describe("разметка", () => {
  it("6220 · заголовки, списки, таблица, задачи, цитата и код", async () => {
    const el = await draw(<Markdown text={"## Итог\n\n- [x] готово\n\n> цитата\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n`код`"} />);
    expect(el.querySelector("h2")!.textContent).toBe("Итог");
    expect(el.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(true);
    expect(el.querySelector("blockquote")).not.toBeNull();
    expect(el.querySelector(".md-table table td")!.textContent).toBe("1");
    expect(el.querySelector("p code")!.textContent).toBe("код");
  });

  it("6221 · ссылка — в новой вкладке без доступа к странице", async () => {
    const a = (await draw(<Markdown text="[журнал](https://example.com/ci)" />)).querySelector("a")!;
    expect(a.target).toBe("_blank");
    expect(a.rel).toBe("noopener noreferrer");
  });

  it("6222 · блок кода: язык, подсветка, текст без потерь", async () => {
    const el = await draw(<Markdown text={"```ts\nconst a = 1;\n```"} />);
    expect(el.querySelector(".cb-l")!.textContent).toBe("ts");
    expect(el.querySelector("pre code")!.textContent).toBe("const a = 1;");
    expect(el.querySelector(".hljs-keyword")!.textContent).toBe("const");
  });

  it("6223 · неизвестный язык — код без подсветки, не падает", async () => {
    const el = await draw(<Markdown text={"```brainfuck\n+++\n```"} />);
    expect(el.querySelector("pre code")!.textContent).toBe("+++");
  });
});

describe("встроенный HTML", () => {
  it("6224 · разрешённая разметка рисуется", async () => {
    const el = await draw(<Markdown text={"<kbd>K</kbd> <mark>метка</mark> H<sub>2</sub>O\n\n<details><summary>Ещё</summary>\n\nтекст\n\n</details>"} />);
    for (const t of ["kbd", "mark", "sub", "details", "summary"]) expect(el.querySelector(t), t).not.toBeNull();
  });

  it("6225 · скрипты, обработчики, стили, iframe и опасные адреса вырезаны", async () => {
    const el = await draw(<Markdown text={'<script>window.x=1</script><style>body{display:none}</style><iframe src="https://evil.example"></iframe><img src="x" onerror="window.x=1" alt="a"><a href="javascript:alert(1)" onclick="window.x=1">b</a><div style="position:fixed" onmouseover="window.x=1">c</div><form action="https://evil.example"><input name="k"></form>'} />);
    const html = el.innerHTML;
    for (const bad of ["<script", "<style", "<iframe", "onerror", "onclick", "onmouseover", "javascript:", "position:fixed", "<form", "evil.example"]) expect(html, bad).not.toContain(bad);
    expect(el.querySelector("img")!.getAttribute("alt")).toBe("a");
    expect(el.textContent).toContain("c");
  });

  it("6226 · картинка data: разрешена, чужой адрес — без реферера", async () => {
    const el = await draw(<Markdown text={'<img src="data:image/png;base64,AAA" alt="d"> ![x](https://example.com/a.png)'} />);
    const [d, x] = el.querySelectorAll("img");
    expect(d.getAttribute("src")).toBe("data:image/png;base64,AAA");
    expect(x.getAttribute("referrerpolicy")).toBe("no-referrer");
  });
});

describe("песочница", () => {
  it("6227 · документ в iframe: скрипты без доступа к странице, сеть закрыта правилом до содержимого", async () => {
    const f = (await draw(<HtmlFrame html="<h1>Отчёт</h1>" />)).querySelector("iframe")!;
    expect(f.getAttribute("sandbox")).toBe("allow-scripts");
    expect(f.getAttribute("sandbox")).not.toContain("allow-same-origin");
    const doc = framed("<h1>Отчёт</h1>");
    expect(doc.indexOf("Content-Security-Policy")).toBeLessThan(doc.indexOf("<h1>"));
    expect(doc).toContain("default-src 'none'");
    expect(doc).not.toMatch(/connect-src|https?:/);
  });

  it("6228 · блок html: сначала код; «Просмотр» — песочница; «Код» — обратно", async () => {
    const el = await draw(<CodeBlock code="<b>x</b>" lang="html" />);
    expect(el.querySelector("iframe")).toBeNull();
    const toggle = [...el.querySelectorAll("button")].find((b) => b.textContent === "Просмотр")!;
    await act(async () => toggle.click());
    expect(el.querySelector("iframe")).not.toBeNull();
    await act(async () => [...el.querySelectorAll("button")].find((b) => b.textContent === "Код")!.click());
    expect(el.querySelector("iframe")).toBeNull();
  });

  it("6229 · блок на другом языке просмотра не предлагает", async () => {
    const el = await draw(<CodeBlock code="x" lang="ts" />);
    expect([...el.querySelectorAll("button")].some((b) => b.textContent === "Просмотр")).toBe(false);
  });
});
