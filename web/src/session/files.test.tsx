// Эталоны страницы (дизайн «Файлы сессии», 15–22): номер эталона — номер теста. Флот — мок; хранилище — его содержимое по хэшу.
import { SEND_TOOL, SITE_TOOL, type SessionRow } from "@sb/protocol";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as apiModule from "../api.ts";
import { fold } from "../chat/fold.ts";
import type { Mock } from "../mock/fleet.ts";
import { BLOBS, goneTurn, showTurn } from "../mock/show.ts";
import { Composer } from "./Composer.tsx";
import { Md, Rows } from "./Feed.tsx";
// куски страницы, которые лента грузит при первом показе, загружены заранее: показ не ждёт чтения модулей с диска
import "./Markdown.tsx";
import "./Mermaid.tsx";
import type { Talk } from "./talk.ts";

vi.hoisted(() => {
  (globalThis as any).window?.happyDOM?.setURL("http://localhost/?still");
  if (!(document as any).fonts) Object.defineProperty(document, "fonts", { value: { addEventListener() {}, removeEventListener() {} } });
});
// схему рисует библиотека: здесь проверяется, что страница делает с её ответом — рисунок или текст блока
vi.mock("mermaid", () => ({
  default: {
    initialize() {},
    parse: async (code: string) => !code.includes("не схема"),
    render: async () => ({ svg: "<svg xmlns='http://www.w3.org/2000/svg'><text>Схема</text></svg>" }),
  },
}));

let mock: Mock;
/** запросы страницы флоту: имя и ввод */
let calls: Array<{ name: string; input: Record<string, unknown> }>;

function page(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<MantineProvider><QueryClientProvider client={qc}><MemoryRouter>{ui}</MemoryRouter></QueryClientProvider></MantineProvider>);
}

beforeEach(() => {
  apiModule.connect();
  mock = apiModule.mock!;
  calls = [];
  const call = apiModule.api.call.bind(apiModule.api);
  vi.spyOn(apiModule.api, "call").mockImplementation(async (def: any, input: any, o?: any) => {
    calls.push({ name: def.name, input });
    const out = await call(def, input, o);
    // ссылка хранилища: содержимое читается по ней, а не из ответа запроса
    return def.name === "files.get" ? { url: `https://store.test/${input.hash}${input.name ? `?name=${encodeURIComponent(input.name)}` : ""}` } : out;
  });
  vi.stubGlobal("fetch", async (url: string) => {
    const blob = BLOBS.get(new URL(url).pathname.slice(1));
    return blob ? new Response(await blob.arrayBuffer()) : new Response(null, { status: 404 });
  });
});
afterEach(() => (cleanup(), vi.restoreAllMocks(), vi.unstubAllGlobals(), mock.stop()));

const session = (c: string): SessionRow => mock.state.sessions[c]!;
const fakeTalk = (): Talk => ({ view: {} as never, events: [], loading: false, error: null, more: false, loadMore() {}, send: vi.fn(async () => true), cancel: vi.fn(async () => null), resend() {}, drop() {}, asides: [], aside: vi.fn(), dropAside() {} });
const sha = async (bytes: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.buffer as ArrayBuffer))].map((x) => x.toString(16).padStart(2, "0")).join("");
const gets = () => calls.filter((c) => c.name === "files.get");
/** Лента из событий разговора — как её сворачивает страница. */
const feed = (events: unknown[]) => {
  const view = fold(events as never);
  return page(<Rows rows={view.rows} view={view} />);
};
const sent = (path: string) => document.querySelector(`.fileshow[data-file="${path}"]`) as HTMLElement;
const turn = () => showTurn(Date.now() - 60_000, "docs@laptop", "Покажи время ответа за сутки.");
/** Ответ вызова отправки файла с этим путём: имя, хэш, размер. */
function answerOf(events: any[], path: string): { name: string; hash: string; size: number } {
  const blocks = events.flatMap((e) => (Array.isArray(e.message?.content) ? e.message.content : []));
  const id = blocks.find((b: any) => b.type === "tool_use" && b.input?.path === path).id;
  return JSON.parse(blocks.find((b: any) => b.type === "tool_result" && b.tool_use_id === id).content);
}

describe("файлы: человек загружает", () => {
  it("эталон 15 · файл любого вида в поле ввода: хэш в браузере, загрузка по ссылке; в сообщении — имя, хэш, размер", async () => {
    const talk = fakeTalk();
    page(<Composer s={session("docs@laptop")} talk={talk} />);
    const box = screen.getByLabelText("Сообщение сессии");
    const bytes = new Uint8Array(3072).fill(7);
    const hash = await sha(bytes);
    // хэш браузер считает вне часов теста: ждём сам расчёт — n-й вызов
    const digest = vi.spyOn(crypto.subtle, "digest");
    const hashed = async (n: number) => (await waitFor(() => expect(digest).toHaveBeenCalledTimes(n)), await digest.mock.results[n - 1]!.value);
    fireEvent.paste(box, { clipboardData: { files: [new File([bytes], "dump.bin", { type: "application/octet-stream" })] } });
    await waitFor(() => expect(screen.getByText("dump.bin")).toBeTruthy());
    fireEvent.change(box, { target: { value: "Вот дамп, разбери его." } });
    fireEvent.keyDown(box, { key: "Enter" });
    await hashed(1);
    await waitFor(() => expect(talk.send).toHaveBeenCalledWith("Вот дамп, разбери его.", [{ name: "dump.bin", hash, size: 3072 }], undefined));
    // содержимое ушло в хранилище по ссылке, а не в сообщение
    expect(calls.find((c) => c.name === "files.put")!.input).toEqual({ files: [{ hash, size: 3072 }] });
    expect(BLOBS.get(hash)?.size).toBe(3072);
    // то же содержимое второй раз: ссылки нет — загрузки нет
    const put = vi.spyOn(mock, "put");
    fireEvent.paste(box, { clipboardData: { files: [new File([bytes], "копия.bin")] } });
    fireEvent.change(box, { target: { value: "ещё раз" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await hashed(2);
    await waitFor(() => expect(talk.send).toHaveBeenCalledWith("ещё раз", [{ name: "копия.bin", hash, size: 3072 }], undefined));
    expect(put).not.toHaveBeenCalled();
  });

  it("эталон 16 · сообщение человека с файлами: превью картинки; документ строкой с размером и «скачать»", async () => {
    feed(turn());
    const pic = await waitFor(() => {
      const img = document.querySelector('.me-pic[data-file="maket.png"] img') as HTMLImageElement | null;
      expect(img).toBeTruthy();
      return img!;
    });
    expect(pic.src).toMatch(/^blob:/);
    const doc = document.querySelector('.me-file[data-file="spec.pdf"]') as HTMLElement;
    expect(doc.textContent).toContain("spec.pdf");
    expect(doc.textContent).toContain("2,3 МБ");
    expect(screen.getByRole("button", { name: "Скачать spec.pdf" })).toBeTruthy();
    // документ не читается, пока его не скачивают
    expect(gets().map((c) => c.input.hash)).not.toContain((turn()[0] as any).files[1].hash);
  });
});

describe("файлы: сессия отправила", () => {
  it("эталон 17 · вызов отправки с ответом: файл в ленте под подписью; строки инструмента нет; «целиком» без второго чтения", async () => {
    feed(turn());
    const card = sent("out/latency.svg");
    expect(card.textContent).toContain("Время ответа за сутки");
    expect(card.textContent).toContain("out/latency.svg");
    await waitFor(() => expect(card.querySelector("img.pic")).toBeTruthy());
    // вызовы отправки и сайта стоят в ленте сами: в стопке строк инструментов их нет
    for (const row of document.querySelectorAll(".toolrow")) expect(row.textContent).not.toMatch(/Отправка файла|Сайт/);
    const { hash } = answerOf(turn(), "out/latency.svg");
    const before = gets().filter((c) => c.input.hash === hash).length;
    fireEvent.click(screen.getByRole("button", { name: "Открыть целиком: Время ответа за сутки" }));
    expect(document.querySelector('[data-step="file"] img.filepic')).toBeTruthy();
    expect(gets().filter((c) => c.input.hash === hash)).toHaveLength(before);
    expect(before).toBe(1);
  });

  it("эталон 18 · вид не показывается (архив): строка со «скачать»; файл скачивается под своим именем", async () => {
    feed(turn());
    const card = sent("dist/report.zip");
    expect(card.textContent).toContain("Сборка отчёта");
    expect(card.textContent).toContain("47 КБ");
    expect(card.querySelector("img, iframe, pre")).toBeNull();
    const clicked: Array<{ href: string; download: string }> = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push({ href: this.href, download: this.download });
    });
    fireEvent.click(screen.getByRole("button", { name: "Скачать report.zip" }));
    await waitFor(() => expect(clicked).toHaveLength(1));
    // ссылка несёт имя: хранилище отдаёт файл вложением под ним
    expect(gets().at(-1)!.input).toMatchObject({ name: "report.zip" });
    expect(clicked[0]).toMatchObject({ download: "report.zip", href: expect.stringContaining("name=report.zip") });
    // до скачивания содержимое архива не читалось
    expect(gets().filter((c) => c.input.hash === gets().at(-1)!.input.hash)).toHaveLength(1);
  });

  it("эталон 19 · вызов сайта с ответом: сайт в рамке-песочнице; адрес открывается в новой вкладке", () => {
    feed(turn());
    const card = document.querySelector('.fileshow[data-site="out/site"]') as HTMLElement;
    expect(card.textContent).toContain("Отчёт за сутки");
    const frame = card.querySelector("iframe.htmlframe") as HTMLIFrameElement;
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts allow-forms");
    expect(frame.getAttribute("src")).toMatch(/\/s\/[0-9a-f]{32}\//);
    const link = card.querySelector("a") as HTMLAnchorElement;
    expect([link.getAttribute("href"), link.target, link.rel]).toEqual([frame.getAttribute("src"), "_blank", "noreferrer noopener"]);
    fireEvent.click(screen.getByRole("button", { name: "Открыть целиком: Отчёт за сутки" }));
    expect(document.querySelector('[data-step="file"] iframe.htmlframe')?.getAttribute("src")).toBe(frame.getAttribute("src"));
  });

  it("эталон 20 · блок ```mermaid: схема; не разобралась — текст блока", async () => {
    page(<Md text={"Так идёт отправка:\n\n```mermaid\nsequenceDiagram\n  C->>H: file_send\n```\n\n```mermaid\nэто не схема\n```"} />);
    const blocks = await waitFor(() => {
      const list = [...document.querySelectorAll(".codeblock")];
      expect(list).toHaveLength(2);
      expect(list[0]!.querySelector("img.svgview")).toBeTruthy();
      expect(list[1]!.querySelector("pre")?.textContent).toBe("это не схема");
      return list;
    });
    expect(blocks[1]!.querySelector("img")).toBeNull();
    // схема открывается тем же листом «целиком»; «Код» возвращает текст блока
    fireEvent.click(screen.getByRole("button", { name: "Открыть схему целиком" }));
    await waitFor(() => expect(document.querySelector('[data-step="file"] img.svgview')).toBeTruthy());
    fireEvent.click(blocks[0]!.querySelector("button.linkbtn")!);
    expect(blocks[0]!.querySelector("pre")?.textContent).toContain("sequenceDiagram");
  });

  it("эталон 21 · содержимого нет или вызов отказан: слово на месте файла, лента цела", async () => {
    const refused = [
      { type: "assistant", uuid: "a9", message: { role: "assistant", content: [{ type: "tool_use", id: "t9", name: SEND_TOOL, input: { to: "nightcheck@server", path: "out/нет.png", title: "Снимок" } }] } },
      { type: "user", uuid: "u9", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t9", is_error: true, content: "no_file: out/нет.png: такого файла нет (trace t1)" }] } },
      { type: "assistant", uuid: "a10", message: { role: "assistant", content: [{ type: "tool_use", id: "t10", name: SITE_TOOL, input: { to: "nightcheck@server", dir: "out/пусто" } }] } },
      { type: "user", uuid: "u10", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t10", is_error: true, content: "no_index: out/пусто: в папке нет index.html (trace t2)" }] } },
    ];
    feed([...goneTurn(Date.now() - 60_000, "nightcheck@server", "Проверь флот.", "Три машины из четырёх на сборке 412."), ...refused]);
    // ответ есть, содержимого в хранилище нет
    await waitFor(() => expect(sent("out/builds.png").querySelector(".filefail")?.textContent).toBe("Такого файла нет"));
    expect(sent("out/builds.png").textContent).toContain("Сборки по машинам");
    // вызов отказан словом — оно и стоит на месте файла и сайта
    expect(sent("out/нет.png").querySelector(".filefail")?.textContent).toBe("Такого файла нет");
    expect(document.querySelector('.fileshow[data-site="out/пусто"] .filefail')?.textContent).toBe("В папке нет index.html");
    expect(document.querySelector('.fileshow[data-site="out/пусто"] iframe')).toBeNull();
    // лента цела: сообщение человека и ответ сессии на месте
    expect(screen.getByText("Проверь флот.")).toBeTruthy();
    expect(screen.getByText(/Три машины из четырёх/)).toBeTruthy();
  });

  it("эталон 22 · лента архива, машина выключена: файлы и сайт показываются так же", async () => {
    // разговор из архива: только записи разговора — вызовы и ответы; машины и её сессии во флоте нет
    const archived = turn().filter((e: any) => e.type === "assistant" || e.type === "user");
    expect(session("gone@offline")).toBeUndefined();
    feed(archived);
    await waitFor(() => expect(sent("out/latency.svg").querySelector("img.pic")).toBeTruthy());
    await waitFor(() => expect(sent("shots/header-390.png").querySelector("img.pic")).toBeTruthy());
    expect(document.querySelector('.fileshow[data-site="out/site"] iframe.htmlframe')).toBeTruthy();
    expect(document.querySelector('.me-pic[data-file="maket.png"]')).toBeTruthy();
    // страница ходила только в службу файлов: запросов машине нет
    expect([...new Set(calls.map((c) => c.name))]).toEqual(["files.get"]);
  });
});
