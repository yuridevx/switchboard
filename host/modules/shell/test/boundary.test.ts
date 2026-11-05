// Леса границы, шеллы: shell.run, wait, kill, info и инструменты MCP на стенде Host. Поддельные SDK и relay, шеллы настоящие —
// bash (Git Bash на Windows), PowerShell где есть. Вторая машина — второй стенд: кадры между поддельными relay ходят по machine и to, как в рации.
// Отдельный файл: настоящие процессы с запасом по времени, остальные флоу границы идут на подделках.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stand } from "@switchboard/host";
import type { Attachment, Frame, Manifest } from "@switchboard/host";
import { machineOf, MAX_FRAME } from "@switchboard/protocol";
import fleetManifest from "../../fleet/module.json" with { type: "json" };
import { make as makeFleet } from "../../fleet/contract.ts";
import chatManifest from "../../chat/module.json" with { type: "json" };
import { make as makeChat } from "../../chat/contract.ts";
import manifest from "../module.json" with { type: "json" };
import shellPkg, { make } from "../contract.ts";

const { standHost, until } = stand;
type Stand = stand.Stand;
type Blocks = { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; isError?: boolean };
type Snapshot = { state: string; code?: number | null; ms: number; stdout: string; stderr: string; files?: Attachment[] };

const win = process.platform === "win32";
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
/** Срок итога: сутки от конца запуска (слово пользователя 1 нояб.). */
const TTL_MS = 24 * 60 * 60 * 1000;
const runDir = (id: string) => join(tmpdir(), "switchboard-shell", "runs", id);
let seq = 0;
const rid = (n: number | string) => `t${n}-${process.pid}-${++seq}`;

const stands: Stand[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const s of stands.splice(0)) await s.close();
});

async function machine(name: string) {
  const f = make();
  const st = await standHost({ machine: name, modules: [{ manifest: chatManifest as Manifest, module: makeChat() }, { manifest: fleetManifest as Manifest, module: makeFleet().module }, { manifest: manifest as Manifest, module: f.module }] });
  stands.push(st);
  /** Вызов инструмента MCP сессии me — как его зовёт SDK. */
  const tool = async (me: string, name: string, args: Record<string, unknown>, signal?: AbortSignal) => {
    const t = f.tools(me).find((x) => x.name === name)!;
    return (await t.handler(args as never, { signal })) as Blocks;
  };
  /** Запрос программы к Host этой машины. */
  const req = async (type: string, fields: Record<string, unknown>) => (await st.relay.request({ type, v: 1, machine: name, ...fields })) as Frame & { result?: Snapshot };
  return { st, tool, req };
}

/** Две машины: кадр, адресованный другой машине (machine, callsign, to), доставляется её Host; from без поля — @машина. */
async function pair() {
  const a = await machine("win");
  const b = await machine("wsl");
  const route = (x: Stand, y: Stand, self: string, other: string) => {
    const orig = x.relay.receive.bind(x.relay);
    x.relay.receive = (ws, text) => {
      orig(ws, text);
      if (text === "ping") return;
      const f = JSON.parse(text) as Frame;
      if (f.type === "hello") return;
      const dest = typeof f.to === "string" ? machineOf(f.to) : typeof f.machine === "string" ? f.machine : null;
      if (dest === other) y.relay.deliver({ ...f, from: f.from ?? `@${self}` });
    };
  };
  route(a.st, b.st, "win", "wsl");
  route(b.st, a.st, "wsl", "win");
  return { a, b };
}

const said = (st: Stand, cs: string) => st.proc(cs).inputs.map((i) => JSON.stringify(i.message?.content ?? "")).join("\n");

describe("контракт shell", () => {
  it("пакет отдаёт объект модуля; вклад в query(): сервер MCP shell", async () => {
    expect(typeof shellPkg).toBe("object");
    const { st } = await machine("laptop");
    await st.open("site@laptop");
    const servers = st.query("site@laptop").options.mcpServers as Record<string, { name?: string }>;
    expect(servers.shell).toMatchObject({ type: "sdk", name: "shell" });
  });

  it("инструменты слово в слово — их читает модель", () => {
    const tools = make().tools("me@pc") as unknown as Array<{ name: string; description: string; inputSchema: Record<string, { description?: string }> }>;
    const params = (t: (typeof tools)[number]) => Object.fromEntries(Object.entries(t.inputSchema).map(([k, v]) => [k, v.description ?? null]));
    const machineWord = "машина флота: win, wsl…; своя тоже";
    expect(tools.map((t) => [t.name, t.description, params(t)])).toEqual([
      ["info", "Какие шеллы есть на машине: версия и путь. Список машин и их ОС — mcp__parts__list.", { machine: machineWord }],
      [
        "run",
        "Запустить скрипт bash или PowerShell на машине флота. Скрипт стартует в домашней папке; stdin отдаётся целиком и закрывается. " +
          "Файлы, положенные в $SB_OUT ($env:SB_OUT), вернутся: картинки — изображением, текст — текстом, прочее — файлом на этой машине. " +
          "По таймауту убивается всё дерево процесса. background: false — когда итог нужен для следующего шага и скрипт недолгий: ход ждёт итога, Esc гасит скрипт. " +
          "background: true — для долгого, с обязательным timeout: ответ сразу; посмотреть или дождаться — wait, погасить — kill; о конце придёт сообщение флота.",
        {
          machine: machineWord,
          shell: "из info: bash · pwsh · powershell",
          script: "текст скрипта",
          stdin: "ввод: отдаётся целиком и закрывается",
          timeout: "секунды жизни скрипта: по умолчанию 120, при background: true — обязательно",
          background: "обязательный выбор: false — ждать итога, true — в фоне",
        },
      ],
      [
        "wait",
        "Дождаться конца запуска, но не дольше timeout секунд: кончился — итог с файлами, не кончился — всё накопленное, state running. " +
          "timeout: 0 — посмотреть сейчас. Итог хранится сутки после конца; читать его можно сколько угодно раз. Esc обрывает только ожидание.",
        { machine: machineWord, run: "id запуска из ответа run", timeout: "секунды ожидания; 0 — сразу" },
      ],
      ["kill", "Погасить запуск: убить всё дерево процесса. ok — убит или уже кончился.", { machine: machineWord, run: "id запуска" }],
    ]);
  });

  it("E21 · 294 · 3081 · отказ машины — текстом для модели, слово в слово; timeout: info — повтори, run — запуск мог начаться", async () => {
    // источник: находка архитектора: у долгого run скрипт ещё работает, повтор запустил бы его второй раз; принятый дизайн — тексты отказов
    const m = await machine("win");
    let word = "offline";
    let extra: Record<string, unknown> = {};
    const recv = m.st.relay.receive.bind(m.st.relay);
    m.st.relay.receive = (ws, text) => {
      recv(ws, text);
      if (text === "ping") return;
      const f = JSON.parse(text) as Frame;
      if (f.machine === "far" && typeof f.id === "string") queueMicrotask(() => m.st.relay.deliver({ type: "reply", id: f.id as string, from: "@far", ok: false, error: word, ...extra } as Frame));
    };
    const info = async () => {
      const r = await m.tool("lead@win", "info", { machine: "far" });
      expect(r.isError).toBe(true);
      return r.content[0].text;
    };
    for (const [w, want] of [
      ["no_shell", "no_shell: на машине far нет такого шелла — какие есть, покажет info"],
      ["bad_frame", "bad_frame: запрос не по форме: шелл bash · pwsh · powershell, timeout — секунды больше 0; при background: true timeout обязателен"],
      ["offline", "offline: машины far нет на связи"],
      ["disconnected", "disconnected: связь с машиной far оборвалась, пока ход ждал; если её Host жив — итог отдаст wait по run"],
      ["shutting_down", "shutting_down: Host машины far останавливается и новых запросов не берёт"],
      ["unknown_request", "unknown_request: на машине far нет модуля shell"],
      ["timeout", "timeout: машина far не ответила за 10 с, повтори"],
      ["no_run", "no_run: запуска null на far нет: не было, прошли сутки после конца или Host машины перезапускался"],
      ["странное_слово", "странное_слово: отказ"],
    ]) {
      word = w;
      expect(await info()).toBe(want);
    }
    word = "too_large";
    extra = { bytes: 34000000 };
    expect(await info()).toBe("too_large: ответ 34000000 байт больше кадра рации (32 МиБ): сократи вывод (grep, tail) или сожми файлы в $SB_OUT");
    extra = {};
    word = "timeout";
    const run = await m.tool("lead@win", "run", { machine: "far", shell: "bash", script: "sleep 1", background: false });
    expect(run.isError).toBe(true);
    expect(run.content[0].text).toMatch(/^timeout: запуск \S+ мог начаться, смотри wait по run$/);
    word = "no_run";
    expect((await m.tool("lead@win", "wait", { machine: "far", run: "nope", timeout: 0 })).content[0].text).toBe("no_run: запуска nope на far нет: не было, прошли сутки после конца или Host машины перезапускался");
  });

  it.each<[string, Record<string, unknown>, string]>([
    ["нет id", { shell: "bash", script: "x", background: false }, "run: нужен id запуска"],
    ["плохой id", { run: "a/b", shell: "bash", script: "x", background: false }, "run: нужен id запуска"],
    ["шелл не из списка", { run: "ok1", shell: "zsh", script: "x", background: false }, "shell: zsh — нужен bash, pwsh или powershell"],
    ["нет скрипта", { run: "ok2", shell: "bash", background: false }, "script: нужен текст"],
    ["stdin не текст", { run: "ok3", shell: "bash", script: "x", stdin: 1, background: false }, "stdin: нужен текст"],
    ["нет выбора background", { run: "ok4", shell: "bash", script: "x" }, "background: обязательный выбор true или false"],
    ["timeout ноль", { run: "ok5", shell: "bash", script: "x", timeout: 0, background: false }, "timeout: секунды больше 0"],
    ["фоновый без timeout", { run: "ok6", shell: "bash", script: "x", background: true }, "background: true — timeout обязателен"],
  ])("shell.run не по форме: %s — bad_frame с причиной, ничего не запущено", async (_n, f, why) => {
    const { st, req } = await machine("laptop");
    expect(await req("shell.run", f)).toMatchObject({ ok: false, error: "bad_frame", why });
    expect(st.journal().filter((x) => x.ev === "run_start")).toEqual([]);
  });
});

// настоящие процессы со sleep: запас по времени
describe("запуск", { timeout: 30_000 }, () => {
  it("271 · bash: stdout, stderr, code 3, state exit; конец — по выходу шелла, фоновый sleep запуск не держит; в журнале старт с pid и конец", async () => {
    const { st, req } = await machine("laptop");
    const run = rid(271);
    const r = await req("shell.run", { run, shell: "bash", script: "echo hi; echo err >&2; sleep 20 & exit 3", background: false });
    expect(r).toMatchObject({ ok: true, result: { state: "exit", code: 3, stdout: "hi\n", stderr: "err\n", files: [] } });
    expect(r.result!.ms).toBeLessThan(15_000);
    const j = st.journal().filter((x) => x.run === run);
    expect(j.find((x) => x.ev === "run_start")).toMatchObject({ from: "panel-desk~owner@example.com", shell: "bash", background: false, timeout: 120, line: "echo hi; echo err >&2; sleep 20 & exit 3" });
    expect(typeof j.find((x) => x.ev === "run_start")!.pid).toBe("number");
    expect(j.find((x) => x.ev === "run_end")).toMatchObject({ state: "exit", code: 3, ms: expect.any(Number), bytes: { stdout: 3, stderr: 4 } });
  });

  it("run с занятым id — bad_frame, прежний запуск цел", async () => {
    const { req } = await machine("laptop");
    const run = rid("busy");
    await req("shell.run", { run, shell: "bash", script: "echo one", background: false });
    expect(await req("shell.run", { run, shell: "bash", script: "echo two", background: false })).toMatchObject({ ok: false, error: "bad_frame", why: `run ${run}: такой запуск уже есть` });
    expect((await req("shell.wait", { run, timeout: 0 })).result).toMatchObject({ stdout: "one\n" });
  });

  it("272 · stdin «абв» — в stdout; read без stdin кончается сразу, не висит", async () => {
    const { req } = await machine("laptop");
    const a = await req("shell.run", { run: rid(272), shell: "bash", script: "cat", stdin: "абв", background: false });
    expect(a.result).toMatchObject({ state: "exit", code: 0, stdout: "абв" });
    const b = await req("shell.run", { run: rid(272), shell: "bash", script: 'read x; echo "got:$x"', background: false, timeout: 5 });
    expect(b.result).toMatchObject({ state: "exit", stdout: "got:\n" });
  });

  it("273 · таймаут 1: state timeout, всё дерево мертво — фоновый ребёнок не дожил до своей метки", async () => {
    const { req } = await machine("laptop");
    const run = rid(273);
    const r = await req("shell.run", { run, shell: "bash", script: '(sleep 3; touch "$SB_OUT/alive") & sleep 30; wait', background: false, timeout: 1 });
    expect(r.result).toMatchObject({ state: "timeout", code: null });
    // убит раньше сна в 30 с; точного предела нет: под нагрузкой таймер и убийство дерева запаздывают
    expect(r.result!.ms).toBeLessThan(15_000);
    await new Promise((res) => setTimeout(res, 3500));
    expect((await req("shell.wait", { run, timeout: 0 })).result!.files).toEqual([]);
  });

  it("274 · погасить: Esc ждущего run на второй машине — туда ушёл shell.kill того же run; kill фонового — ok, killed; неизвестный run — no_run", async () => {
    const { a, b } = await pair();
    const esc = new AbortController();
    const call = a.tool("site@win", "run", { machine: "wsl", shell: "bash", script: "sleep 30", background: false }, esc.signal);
    const run = String((await until(() => a.st.relay.frames("shell.run").at(-1))).run);
    await until(() => b.st.journal().some((x) => x.ev === "run_start" && x.run === run));
    esc.abort();
    expect(await until(() => a.st.relay.frames("shell.kill").find((f) => f.run === run))).toMatchObject({ machine: "wsl", run });
    const end = (st: Stand, id: string) => until(() => st.journal().find((x) => x.ev === "run_end" && x.run === id));
    expect(await end(b.st, run)).toMatchObject({ state: "killed", code: null });
    // поздний ответ run: в живой сессии SDK его отбрасывает — вызова уже нет
    expect((await call).content[0].text).toMatch(/^wsl · killed /);
    const bgRun = rid(274);
    expect((await b.req("shell.run", { run: bgRun, shell: "bash", script: "sleep 30", background: true, timeout: 60 })).result).toMatchObject({ state: "running" });
    expect(await a.tool("site@win", "kill", { machine: "wsl", run: bgRun })).toEqual({ content: [{ type: "text", text: "ok" }] });
    expect(await end(b.st, bgRun)).toMatchObject({ state: "killed", code: null });
    expect(await b.req("shell.kill", { run: "nope" })).toMatchObject({ ok: false, error: "no_run" });
    expect(await a.tool("site@win", "kill", { machine: "wsl", run: "nope" })).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/^no_run: /) }] });
  });

  it("275 · $SB_OUT: chart.png, data.json, report.pdf, подпапка — у программы base64 с типами; у модели картинка, текст JSON и путь к PDF на своей машине", async () => {
    const { req, tool } = await machine("laptop");
    const script = `echo ${PNG} | base64 -d > "$SB_OUT/chart.png"; echo '{"a":1}' > "$SB_OUT/data.json"; printf '%%PDF-1.4\\n\\x00\\x01\\x02' > "$SB_OUT/report.pdf"; mkdir "$SB_OUT/d"; echo x > "$SB_OUT/d/note.bin"; echo built`;
    const r = await req("shell.run", { run: rid(275), shell: "bash", script, background: false });
    expect(r.result!.files!.map((f) => [f.name, f.media_type])).toEqual([
      ["chart.png", "image/png"],
      ["d/note.bin", "application/octet-stream"],
      ["data.json", "application/json"],
      ["report.pdf", "application/pdf"],
    ]);
    expect(r.result!.files![0].data).toBe(PNG);
    const m = await tool("site@laptop", "run", { machine: "laptop", shell: "bash", script, background: false });
    const img = m.content.find((c) => c.type === "image")!;
    expect(img).toMatchObject({ mimeType: "image/png", data: PNG });
    expect(m.content.some((c) => c.text === "── chart.png (image/png) — картинка ──")).toBe(true);
    expect(m.content.some((c) => c.text?.includes('── data.json (application/json) ──\n{"a":1}'))).toBe(true);
    const pdf = m.content.find((c) => c.text?.startsWith("── report.pdf"))!.text!;
    expect(pdf).toMatch(/^── report\.pdf \(application\/pdf, 1 КБ\) — файл: .+$/);
    expect(existsSync(/файл: (.+)$/.exec(pdf)![1])).toBe(true);
    expect(m.content[0].text).toMatch(/^laptop · exit 0 · \d+\.\d с · run \w+\n── stdout ──\nbuilt/);
  });

  it("у модели: пустой вывод — «(пусто)», stderr отдельным блоком; длительность от минуты — «1 мин 05 с»; остальное состояние словом", async () => {
    const { st, tool } = await machine("laptop");
    const m = await tool("site@laptop", "run", { machine: "laptop", shell: "bash", script: "echo err >&2", background: false });
    expect(m.content[0].text).toMatch(/── stdout ──\n\(пусто\)\n── stderr ──\nerr/);
    const recv = st.relay.receive.bind(st.relay);
    st.relay.receive = (ws, text) => {
      recv(ws, text);
      if (text === "ping") return;
      const f = JSON.parse(text) as Frame;
      if (f.type === "shell.wait") queueMicrotask(() => st.relay.deliver({ type: "reply", id: f.id as string, from: "@far", ok: true, result: { state: "timeout", code: null, ms: 65_000, stdout: "x", stderr: "" } } as Frame));
    };
    const w = await tool("site@laptop", "wait", { machine: "far", run: "r1", timeout: 0 });
    expect(w).toEqual({ content: [{ type: "text", text: "far · timeout · 1 мин 05 с · run r1\n── stdout ──\nx" }] });
  });

  it("276 · PowerShell: Write-Output 'привет' — «привет» в stdout; Read-Host падает сразу", async (t) => {
    const { req } = await machine("laptop");
    const info = (await req("shell.info", {})) as unknown as { result: { shells: Record<string, unknown> } };
    const list = Object.keys(info.result.shells).filter((x) => x !== "bash");
    if (!list.length) return t.skip();
    for (const sh of list) {
      const r = await req("shell.run", { run: rid(276), shell: sh, script: "Write-Output 'привет'", background: false });
      expect(r.result).toMatchObject({ state: "exit", code: 0, stdout: win ? "привет\r\n" : "привет\n" });
      const q = await req("shell.run", { run: rid(276), shell: sh, script: "$x = Read-Host 'имя'; Write-Output \"got:$x\"", background: false, timeout: 20 });
      // -NonInteractive: Read-Host сразу отказывает с ошибкой, клавиатуру не ждёт
      expect(q.result!.state).toBe("exit");
      expect(q.result!.stderr).toMatch(/NonInteractive/i);
    }
  });

  it("277 · шелла нет — no_shell; ничего не запущено", async () => {
    const { req } = await machine("laptop");
    const run = rid(277);
    const old = { PATH: process.env.PATH, Path: process.env.Path };
    try {
      if (win) process.env.PATH = process.env.Path = "";
      const r = await req("shell.run", { run, shell: win ? "pwsh" : "powershell", script: "Write-Output 1", background: false });
      expect(r).toMatchObject({ ok: false, error: "no_shell", why: `${win ? "pwsh" : "powershell"}: на машине laptop нет` });
    } finally {
      if (win) Object.assign(process.env, old);
    }
    expect(existsSync(runDir(run))).toBe(false);
  });

  it("280 · info: шеллы машины с версиями и путями", async () => {
    const { req, tool } = await machine("laptop");
    const r = (await req("shell.info", {})) as unknown as { result: { shells: Record<string, { version: string; path: string }> } };
    expect(r.result.shells.bash.version).toMatch(/^\d+\.\d+/);
    expect(existsSync(r.result.shells.bash.path)).toBe(true);
    if (win) expect(r.result.shells.powershell.version).toMatch(/^5\.1/);
    const m = await tool("site@laptop", "info", { machine: "laptop" });
    expect(JSON.parse(m.content[0].text!)).toEqual(r.result.shells);
  });

  it("281 · остановка Host посреди ждущего run, wait и фонового: ждущим — stopped с выводом; владельцу фонового на другой машине — «итог не сохранён»; процессов, итогов и папок нет", async () => {
    const { a, b } = await pair();
    await a.st.open("site@win");
    const mark = mkdtempSync(join(tmpdir(), "sb-281-"));
    const old = rid(281);
    await b.req("shell.run", { run: old, shell: "bash", script: "echo old", background: false });
    const sync = a.tool("site@win", "run", { machine: "wsl", shell: "bash", script: `echo before; (sleep 2; touch "${mark.split("\\").join("/")}/alive") & sleep 30`, background: false });
    const bg = await a.tool("site@win", "run", { machine: "wsl", shell: "bash", script: "echo bg; sleep 30", background: true, timeout: 60 });
    const bgRun = /run (\w+)/.exec(bg.content[0].text!)![1];
    const waiting = a.tool("site@win", "wait", { machine: "wsl", run: bgRun, timeout: 60 });
    await until(() => b.st.journal().filter((x) => x.ev === "run_start").length === 3);
    await new Promise((res) => setTimeout(res, 300));
    await b.st.close();
    expect((await sync).content[0].text).toMatch(/^wsl · stopped .*\n── stdout ──\nbefore/);
    expect((await waiting).content[0].text).toMatch(/^wsl · stopped .*\n── stdout ──\nbg/);
    await until(() => said(a.st, "site@win").includes(`run ${bgRun} на wsl остановлен: Host wsl перезапускается, итог не сохранён`));
    expect(said(a.st, "site@win")).toContain('from=\\"@wsl\\"');
    for (const id of [old, bgRun]) expect(existsSync(runDir(id))).toBe(false);
    await new Promise((res) => setTimeout(res, 2500));
    expect(existsSync(join(mark, "alive"))).toBe(false);
  });

  it("283 · фоновый на своей машине и на второй: снимок running сразу; в конце — сообщение владельцу; wait — итог с файлами; без timeout — bad_frame, скрипт не запущен", async () => {
    const { a } = await pair();
    await a.st.open("site@win");
    for (const m of ["win", "wsl"]) {
      const t = await a.tool("site@win", "run", { machine: m, shell: "bash", script: `echo start; sleep 1; echo ${PNG} | base64 -d > "$SB_OUT/p.png"; echo done`, background: true, timeout: 30 });
      expect(t.content[0].text).toMatch(new RegExp(`^${m} · running · .* · run (\\w+) — идёт в фоне: wait — посмотреть или дождаться, kill — погасить; о конце придёт сообщение флота`));
      const run = /run (\w+)/.exec(t.content[0].text!)![1];
      await until(() => said(a.st, "site@win").includes(`run ${run} на ${m} кончился: exit 0`), 10000);
      expect(said(a.st, "site@win")).toContain(`Итог — mcp__shell__wait {\\"machine\\":\\"${m}\\",\\"run\\":\\"${run}\\",\\"timeout\\":0}`);
      const w = await a.tool("site@win", "wait", { machine: m, run, timeout: 0 });
      expect(w.content[0].text).toMatch(new RegExp(`^${m} · exit 0 · .*\\n── stdout ──\\nstart\\ndone`));
      expect(w.content.some((c) => c.type === "image")).toBe(true);
    }
    const nt = await a.tool("site@win", "run", { machine: "win", shell: "bash", script: "echo x", background: true });
    expect(nt).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/^bad_frame: /) }] });
    expect(a.st.journal().filter((x) => x.ev === "run_start").length).toBe(1);
  });

  it("284 · wait 0 посреди запуска: сразу running, stdout с уже напечатанными строками, файлов нет; у фонового снимка кода и файлов нет", async () => {
    const { req } = await machine("laptop");
    const run = rid(284);
    const started = await req("shell.run", { run, shell: "bash", script: "for i in 1 2 3 4 5; do echo line$i; sleep 1; done", background: true, timeout: 30 });
    expect(started.result).toMatchObject({ state: "running" });
    expect(started.result).not.toHaveProperty("code");
    expect(started.result).not.toHaveProperty("files");
    await new Promise((res) => setTimeout(res, 2500));
    const w = await req("shell.wait", { run, timeout: 0 });
    expect(w.result).toMatchObject({ state: "running" });
    expect(w.result!.stdout).toMatch(/^line1\n/);
    expect(w.result).not.toHaveProperty("files");
    await req("shell.kill", { run });
  });

  it("285 · wait 5 у запуска, который кончится через 1 с, — итог в момент конца; wait 1 у запуска на 30 с — running через 1 с, запуск идёт", async () => {
    const { req } = await machine("laptop");
    const quick = rid(285);
    await req("shell.run", { run: quick, shell: "bash", script: "sleep 1; echo ok", background: true, timeout: 30 });
    const w = await req("shell.wait", { run: quick, timeout: 15 });
    expect(w.result).toMatchObject({ state: "exit", code: 0, stdout: "ok\n" });
    const slow = rid(285);
    await req("shell.run", { run: slow, shell: "bash", script: "sleep 30", background: true, timeout: 60 });
    const t0 = Date.now();
    const s = await req("shell.wait", { run: slow, timeout: 1 });
    expect(s.result).toMatchObject({ state: "running" });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(900);
    expect((await req("shell.wait", { run: slow, timeout: 0 })).result!.state).toBe("running");
    await req("shell.kill", { run: slow });
  });

  it("3077 · ждущий run и wait того же запуска — итог обоим в момент конца", async () => {
    const { req } = await machine("laptop");
    const run = rid(3077);
    const sync = req("shell.run", { run, shell: "bash", script: "sleep 1; echo done", background: false });
    await until(() => existsSync(runDir(run)));
    const w = await req("shell.wait", { run, timeout: 15 });
    const s = await sync;
    expect(w.result).toMatchObject({ state: "exit", code: 0, stdout: "done\n" });
    expect(s.result).toMatchObject({ state: "exit", code: 0, stdout: "done\n" });
  });

  it("286 · Esc посреди wait фонового: на машину-цель ничего не ушло, скрипт идёт, в конце — сообщение владельцу", async () => {
    const { a } = await pair();
    await a.st.open("site@win");
    const t = await a.tool("site@win", "run", { machine: "wsl", shell: "bash", script: "sleep 1; echo fin", background: true, timeout: 30 });
    const run = /run (\w+)/.exec(t.content[0].text!)![1];
    const esc = new AbortController();
    const sent = a.st.relay.sent.length;
    void a.tool("site@win", "wait", { machine: "wsl", run, timeout: 60 }, esc.signal);
    await until(() => a.st.relay.frames("shell.wait").length === 1);
    esc.abort();
    await until(() => said(a.st, "site@win").includes(`run ${run} на wsl кончился: exit 0`), 10000);
    expect(a.st.relay.sent.slice(sent).map((f) => f.type)).not.toContain("shell.kill");
  });

  it("287 · итог живёт сутки: через минуту wait отдаёт итог, второй раз — тот же; после суток — no_run, папки нет", async () => {
    const { req } = await machine("laptop");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const run = rid(287);
    const r = await req("shell.run", { run, shell: "bash", script: "echo kept", background: false });
    expect(r.result).toMatchObject({ state: "exit", stdout: "kept\n" });
    vi.advanceTimersByTime(60_000);
    const w1 = await req("shell.wait", { run, timeout: 0 });
    const w2 = await req("shell.wait", { run, timeout: 0 });
    expect(w1.result).toMatchObject({ state: "exit", stdout: "kept\n" });
    expect(w2.result).toEqual(w1.result);
    vi.advanceTimersByTime(TTL_MS);
    expect(await req("shell.wait", { run, timeout: 0 })).toMatchObject({ ok: false, error: "no_run", why: `run ${run}: запуска нет` });
    expect(existsSync(runDir(run))).toBe(false);
  });

  // источник: принятый дизайн — вход wait «"timeout": 60 } // обязательно: секунды ожидания; 0 — сразу»
  it("288 · wait без timeout — bad_frame; запуск идёт как шёл", async () => {
    const { req } = await machine("laptop");
    const run = rid(288);
    await req("shell.run", { run, shell: "bash", script: "sleep 30", background: true, timeout: 60 });
    expect(await req("shell.wait", { run })).toMatchObject({ ok: false, error: "bad_frame", why: "timeout: секунды ожидания, 0 — сразу" });
    expect((await req("shell.wait", { run, timeout: 0 })).result!.state).toBe("running");
    await req("shell.kill", { run });
  });

  // источник: принятый дизайн — shell.kill «← { "ok": true } // убит или уже кончился»
  it("289 · kill кончившегося запуска — ok, итог прежний", async () => {
    const { req } = await machine("laptop");
    const run = rid(289);
    await req("shell.run", { run, shell: "bash", script: "echo kept", background: false });
    expect(await req("shell.kill", { run })).toMatchObject({ ok: true });
    expect((await req("shell.wait", { run, timeout: 0 })).result).toMatchObject({ state: "exit", code: 0, stdout: "kept\n" });
  });

  // источник: принятый дизайн — «Владелец — программа: сообщения нет, message доставляет только сессиям; конец видно по wait»
  it("290 · фоновый программы: в конце сообщения нет — ни запроса message, ни строки отказа; итог отдаёт wait", async () => {
    const { st, req } = await machine("laptop");
    const run = rid(290);
    await req("shell.run", { run, shell: "bash", script: "echo bg", background: true, timeout: 30 });
    expect((await req("shell.wait", { run, timeout: 15 })).result).toMatchObject({ state: "exit", code: 0, stdout: "bg\n" });
    await new Promise((res) => setTimeout(res, 300));
    expect(st.journal().filter((x) => x.ev === "run_message")).toEqual([]);
    expect(st.relay.frames("message")).toEqual([]);
  });

  // источник: принятый дизайн — «Не доставилось — строка в журнале»; «итог ждёт wait сутки»
  it("291 · сообщение о конце фонового не доставлено — сессии владельца нет: строка отказа run_message; итог отдаёт wait", async () => {
    const { st, req } = await machine("laptop");
    const run = rid(291);
    await req("shell.run", { run, from: "ghost@laptop", shell: "bash", script: "echo bg", background: true, timeout: 30 });
    expect(await until(() => st.journal().find((x) => x.ev === "run_message" && x.run === run))).toMatchObject({ kind: "refuse", word: "offline", to: "ghost@laptop", why: `сообщение о конце run ${run} не доставлено: offline` });
    expect((await req("shell.wait", { run, timeout: 0 })).result).toMatchObject({ state: "exit", code: 0, stdout: "bg\n" });
  });

  // источник: факт Cloudflare — сообщение WebSocket в Durable Object до 32 МиБ; принятый дизайн, сценарий «Вывод не влез»
  it("292 · вывод больше кадра рации: модели — too_large с размером; в журнале цели — конец с кодом и байтами; связь цели жива", async () => {
    const { a, b } = await pair();
    const r = await a.tool("site@win", "run", { machine: "wsl", shell: "bash", script: "yes | head -c 34000000", background: false });
    expect(r.isError).toBe(true);
    const bytes = Number(/^too_large: ответ (\d+) байт больше кадра рации \(32 МиБ\)/.exec(r.content[0].text!)?.[1]);
    expect(bytes).toBeGreaterThan(MAX_FRAME);
    const run = String(a.st.relay.frames("shell.run").at(-1)!.run);
    expect(b.st.journal().find((x) => x.ev === "run_end" && x.run === run)).toMatchObject({ state: "exit", code: 0, bytes: { stdout: 34_000_000 } });
    expect((await a.tool("site@win", "info", { machine: "wsl" })).isError).toBeUndefined();
  });

  // источник: принятый дизайн, сценарий «Host wsl упал» — «Клиент рации отпускает ждущих, когда машина-адресат ушла. Своего таймера нет. … после подъёма Host — no_run»
  it("295 · Host цели упал посреди ждущего run: модели сразу disconnected текстом; поднятый Host цели — no_run", async () => {
    const { a, b } = await pair();
    const roster = (machines: string[]) => ({ type: "roster", machines: machines.map((machine) => ({ machine, since: 1 })), sessions: [], clients: [] });
    a.st.relay.deliver(roster(["win", "wsl"]));
    const call = a.tool("site@win", "run", { machine: "wsl", shell: "bash", script: "sleep 3", background: false });
    const run = String((await until(() => a.st.relay.frames("shell.run").at(-1))).run);
    await until(() => b.st.journal().some((x) => x.ev === "run_start" && x.run === run));
    b.st.crash();
    a.st.relay.deliver(roster(["win"]));
    expect(await call).toEqual({ content: [{ type: "text", text: "disconnected: связь с машиной wsl оборвалась, пока ход ждал; если её Host жив — итог отдаст wait по run" }], isError: true });
    const up = await machine("wsl");
    expect(await up.req("shell.wait", { run, timeout: 0 })).toMatchObject({ ok: false, error: "no_run" });
  });

  // на Windows spawn неисполняемого файла бросает EFTYPE синхронно — это не ветка «шелл не стартовал», а ловушка ядра
  it.skipIf(win)("3078 · шелл не стартовал — итог exit без кода, строка run_error (Linux)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sb-3078-"));
    const fake = join(dir, "bash");
    writeFileSync(fake, "не шелл");
    const saved = { path: process.env.PATH };
    process.env.PATH = dir;
    try {
      const { st, req } = await machine("laptop");
      const run = rid(3078);
      const r = await req("shell.run", { run, shell: "bash", script: "echo x", background: false });
      expect(r.result).toMatchObject({ state: "exit", code: null });
      expect(st.journal().some((l) => l.ev === "run_error" && l.run === run)).toBe(true);
    } finally {
      process.env.PATH = saved.path;
    }
  });

  it("3079 · остановка Host, владелец фонового на этой же машине — отказ shutting_down в журнале", async () => {
    const { st, tool } = await machine("laptop");
    await st.open("site@laptop");
    const bg = await tool("site@laptop", "run", { machine: "laptop", shell: "bash", script: "sleep 30", background: true, timeout: 60 });
    const run = /run (\w+)/.exec(bg.content[0].text!)![1];
    stands.splice(stands.indexOf(st), 1);
    await st.close();
    expect(st.journal().find((l) => l.ev === "run_message" && l.run === run)).toMatchObject({ kind: "refuse", word: "shutting_down" });
  });

  it.skipIf(!win)("3080 · через сутки папку держит процесс — итог забыт, причина run_forget в журнале (Windows)", async () => {
    const { st, req } = await machine("laptop");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const run = rid(3080);
    await req("shell.run", { run, shell: "bash", script: "echo held", background: false });
    // файл stdout держит другой процесс без права удаления — как процесс, который скрипт пустил в фон
    const file = join(runDir(run), "stdout").split("\\").join("/");
    const holder = spawn("powershell.exe", ["-NoProfile", "-Command", `$f=[IO.File]::Open('${file}','Open','Read','None'); 'open'; Start-Sleep 20`], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    await new Promise<void>((r) => holder.stdout!.once("data", () => r()));
    try {
      vi.advanceTimersByTime(TTL_MS);
      expect(await req("shell.wait", { run, timeout: 0 })).toMatchObject({ ok: false, error: "no_run" });
      expect(st.journal().some((l) => l.ev === "run_forget" && l.run === run)).toBe(true);
    } finally {
      holder.kill();
      await new Promise((r) => holder.once("exit", r));
      rmSync(runDir(run), { recursive: true, force: true });
    }
  });
});
