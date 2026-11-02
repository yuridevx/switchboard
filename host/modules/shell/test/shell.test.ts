// Эталоны модуля shell на стенде Host: поддельные SDK и relay, шеллы настоящие — bash (Git Bash на Windows),
// PowerShell где есть. Вторая машина — второй стенд: кадры между поддельными relay ходят по machine и to, как в рации.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stand } from "@switchboard/host";
import type { Frame, Manifest } from "@switchboard/host";
import { machineOf, MAX_FRAME } from "@switchboard/protocol";
import fleetManifest from "../../fleet/module.json" with { type: "json" };
import { make as makeFleet } from "../../fleet/src/fleet.ts";
import manifest from "../module.json" with { type: "json" };
import { shellPath } from "../src/run.ts";
import { make, TTL_MS } from "../src/shell.ts";
import type { Snapshot } from "../src/shell.ts";

const { standHost, until } = stand;
type Stand = stand.Stand;
type Blocks = { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; isError?: boolean };

const win = process.platform === "win32";
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const runDir = (id: string) => join(tmpdir(), "switchboard-shell", "runs", id);
let seq = 0;
const rid = (n: number) => `t${n}-${process.pid}-${++seq}`;

const stands: Stand[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const s of stands.splice(0)) await s.close();
});

async function machine(name: string) {
  const f = make();
  const st = await standHost({ machine: name, modules: [{ manifest: fleetManifest as Manifest, module: makeFleet().module }, { manifest: manifest as Manifest, module: f.module }] });
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

// настоящие процессы со sleep: запас по времени
describe("эталоны shell", { timeout: 30_000 }, () => {
  it("271 · bash: stdout, stderr, code 3, state exit; конец — по выходу шелла, фоновый sleep запуск не держит; в журнале старт с pid и конец", async () => {
    const { st, req } = await machine("laptop");
    const run = rid(271);
    const t0 = Date.now();
    const r = await req("shell.run", { run, shell: "bash", script: "echo hi; echo err >&2; sleep 3 & exit 3", background: false });
    expect(Date.now() - t0).toBeLessThan(2500);
    expect(r).toMatchObject({ ok: true, result: { state: "exit", code: 3, stdout: "hi\n", stderr: "err\n", files: [] } });
    const j = st.journal().filter((x) => x.run === run);
    expect(j.find((x) => x.ev === "run_start")).toMatchObject({ from: "panel-desk~owner@example.com", shell: "bash", background: false, timeout: 120, line: "echo hi; echo err >&2; sleep 3 & exit 3" });
    expect(typeof j.find((x) => x.ev === "run_start")!.pid).toBe("number");
    expect(j.find((x) => x.ev === "run_end")).toMatchObject({ state: "exit", code: 3, ms: expect.any(Number), bytes: { stdout: 3, stderr: 4 } });
  });

  it("272 · stdin «абв» — в stdout; read без stdin кончается сразу, не висит", async () => {
    const { req } = await machine("laptop");
    const a = await req("shell.run", { run: rid(272), shell: "bash", script: "cat", stdin: "абв", background: false });
    expect(a.result).toMatchObject({ state: "exit", code: 0, stdout: "абв" });
    const b = await req("shell.run", { run: rid(272), shell: "bash", script: 'read x; echo "got:$x"', background: false, timeout: 5 });
    expect(b.result).toMatchObject({ state: "exit", stdout: "got:\n" });
  });

  it("273 · таймаут 1: state timeout за 1–2 с, всё дерево мертво — фоновый ребёнок не дожил до своей метки", async () => {
    const { req } = await machine("laptop");
    const run = rid(273);
    const t0 = Date.now();
    const r = await req("shell.run", { run, shell: "bash", script: '(sleep 2; touch "$SB_OUT/alive") & sleep 30; wait', background: false, timeout: 1 });
    expect(r.result).toMatchObject({ state: "timeout", code: null });
    expect(Date.now() - t0).toBeLessThan(win ? 4000 : 2500);
    await new Promise((res) => setTimeout(res, 2500));
    expect((await req("shell.wait", { run, timeout: 0 })).result!.files).toEqual([]);
  });

  it("274 · погасить: Esc ждущего run на второй машине — туда ушёл shell.kill того же run, процесс погашен; kill фонового — ok, killed; неизвестный run — no_run", async () => {
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

  it("275 · $SB_OUT: chart.png, data.json, report.pdf — у программы base64 с типами; у модели картинка, текст JSON и путь к PDF на своей машине", async () => {
    const { req, tool } = await machine("laptop");
    const script = `echo ${PNG} | base64 -d > "$SB_OUT/chart.png"; echo '{"a":1}' > "$SB_OUT/data.json"; printf '%%PDF-1.4\\n\\x00\\x01\\x02' > "$SB_OUT/report.pdf"; echo built`;
    const r = await req("shell.run", { run: rid(275), shell: "bash", script, background: false });
    expect(r.result!.files!.map((f) => [f.name, f.media_type])).toEqual([
      ["chart.png", "image/png"],
      ["data.json", "application/json"],
      ["report.pdf", "application/pdf"],
    ]);
    expect(r.result!.files![0].data).toBe(PNG);
    const m = await tool("site@laptop", "run", { machine: "laptop", shell: "bash", script, background: false });
    const img = m.content.find((c) => c.type === "image")!;
    expect(img).toMatchObject({ mimeType: "image/png", data: PNG });
    expect(m.content.some((c) => c.text?.includes('── data.json (application/json) ──\n{"a":1}'))).toBe(true);
    const pdf = m.content.find((c) => c.text?.startsWith("── report.pdf"))!.text!;
    const path = /файл: (.+)$/.exec(pdf)![1];
    expect(existsSync(path)).toBe(true);
    expect(m.content[0].text).toMatch(/^laptop · exit 0 · .* · run \w+\n── stdout ──\nbuilt/);
  });

  const ps = win ? "powershell" : shellPath("pwsh") ? "pwsh" : null;
  it.runIf(ps)("276 · PowerShell: Write-Output 'привет' — «привет» в stdout; Read-Host падает сразу", async () => {
    const { req } = await machine("laptop");
    for (const sh of win && shellPath("pwsh") ? ["powershell", "pwsh"] : [ps!]) {
      const r = await req("shell.run", { run: rid(276), shell: sh, script: "Write-Output 'привет'", background: false });
      expect(r.result).toMatchObject({ state: "exit", code: 0, stdout: "привет\n".replace("\n", win ? "\r\n" : "\n") });
      const t0 = Date.now();
      const q = await req("shell.run", { run: rid(276), shell: sh, script: "$x = Read-Host 'имя'; Write-Output \"got:$x\"", background: false, timeout: 20 });
      // -NonInteractive: Read-Host сразу отказывает с ошибкой, клавиатуру не ждёт
      expect(q.result!.state).toBe("exit");
      expect(q.result!.stderr).toMatch(/NonInteractive/i);
      expect(Date.now() - t0).toBeLessThan(15000);
    }
  });

  it("277 · шелла нет — no_shell; ничего не запущено", async () => {
    const { req } = await machine("laptop");
    const run = rid(277);
    const old = { PATH: process.env.PATH, Path: process.env.Path };
    try {
      if (win) process.env.PATH = process.env.Path = "";
      const r = await req("shell.run", { run, shell: win ? "pwsh" : "powershell", script: "Write-Output 1", background: false });
      expect(r).toMatchObject({ ok: false, error: "no_shell" });
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
      expect(t.content[0].text).toMatch(new RegExp(`^${m} · running · .* · run (\\w+) — идёт в фоне`));
      const run = /run (\w+)/.exec(t.content[0].text!)![1];
      await until(() => said(a.st, "site@win").includes(`run ${run} на ${m} кончился: exit 0`), 10000);
      const w = await a.tool("site@win", "wait", { machine: m, run, timeout: 0 });
      expect(w.content[0].text).toMatch(new RegExp(`^${m} · exit 0 · .*\\n── stdout ──\\nstart\\ndone`));
      expect(w.content.some((c) => c.type === "image")).toBe(true);
    }
    const nt = await a.tool("site@win", "run", { machine: "win", shell: "bash", script: "echo x", background: true });
    expect(nt).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/^bad_frame: /) }] });
    expect(a.st.journal().filter((x) => x.ev === "run_start").length).toBe(1);
  });

  it("284 · wait 0 посреди запуска, который печатает строку в секунду: сразу running, stdout с уже напечатанными строками, файлов нет", async () => {
    const { req } = await machine("laptop");
    const run = rid(284);
    let t0 = Date.now();
    // фоновый: снимок running сразу после старта, без кода и файлов
    const started = await req("shell.run", { run, shell: "bash", script: "for i in 1 2 3 4 5; do echo line$i; sleep 1; done", background: true, timeout: 30 });
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(started.result).toMatchObject({ state: "running" });
    expect(started.result).not.toHaveProperty("code");
    expect(started.result).not.toHaveProperty("files");
    await new Promise((res) => setTimeout(res, 2500));
    t0 = Date.now();
    const w = await req("shell.wait", { run, timeout: 0 });
    expect(Date.now() - t0).toBeLessThan(500);
    expect(w.result).toMatchObject({ state: "running" });
    expect(w.result!.stdout).toMatch(/^line1\nline2\n/);
    expect(w.result).not.toHaveProperty("files");
    await req("shell.kill", { run });
  });

  it("285 · wait 5 у запуска, который кончится через 1 с, — итог в момент конца; wait 1 у запуска на 30 с — running через 1 с, запуск идёт", async () => {
    const { req } = await machine("laptop");
    const quick = rid(285);
    await req("shell.run", { run: quick, shell: "bash", script: "sleep 1; echo ok", background: true, timeout: 30 });
    let t0 = Date.now();
    const w = await req("shell.wait", { run: quick, timeout: 5 });
    expect(w.result).toMatchObject({ state: "exit", code: 0, stdout: "ok\n" });
    expect(Date.now() - t0).toBeLessThan(3000);
    const slow = rid(285);
    await req("shell.run", { run: slow, shell: "bash", script: "sleep 30", background: true, timeout: 60 });
    t0 = Date.now();
    const s = await req("shell.wait", { run: slow, timeout: 1 });
    expect(s.result).toMatchObject({ state: "running" });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(900);
    expect((await req("shell.wait", { run: slow, timeout: 0 })).result!.state).toBe("running");
    await req("shell.kill", { run: slow });
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
    expect(await req("shell.wait", { run, timeout: 0 })).toMatchObject({ ok: false, error: "no_run" });
    expect(existsSync(runDir(run))).toBe(false);
  });

  // источник: принятый дизайн — вход wait «"timeout": 60 } // обязательно: секунды ожидания; 0 — сразу»
  it("288 · wait без timeout — bad_frame; запуск идёт как шёл", async () => {
    const { req } = await machine("laptop");
    const run = rid(288);
    await req("shell.run", { run, shell: "bash", script: "sleep 30", background: true, timeout: 60 });
    expect(await req("shell.wait", { run })).toMatchObject({ ok: false, error: "bad_frame" });
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
    expect((await req("shell.wait", { run, timeout: 10 })).result).toMatchObject({ state: "exit", code: 0, stdout: "bg\n" });
    await new Promise((res) => setTimeout(res, 300));
    expect(st.journal().filter((x) => x.ev === "run_message")).toEqual([]);
    expect(st.relay.frames("message")).toEqual([]);
  });

  // источник: принятый дизайн — «Не доставилось — строка в журнале»; «итог ждёт wait сутки»
  it("291 · сообщение о конце фонового не доставлено — сессии владельца нет: строка отказа run_message в журнале; итог отдаёт wait", async () => {
    const { st, req } = await machine("laptop");
    const run = rid(291);
    await req("shell.run", { run, from: "ghost@laptop", shell: "bash", script: "echo bg", background: true, timeout: 30 });
    expect(await until(() => st.journal().find((x) => x.ev === "run_message" && x.run === run))).toMatchObject({ kind: "refuse", word: "offline", to: "ghost@laptop" });
    expect((await req("shell.wait", { run, timeout: 0 })).result).toMatchObject({ state: "exit", code: 0, stdout: "bg\n" });
  });

  // источник: факт Cloudflare — сообщение WebSocket в Durable Object до 32 МиБ; принятый дизайн, сценарий «Вывод не влез»
  it("292 · вывод больше кадра рации: модели — too_large с размером ответа; в журнале цели — конец с кодом и байтами; связь цели жива", async () => {
    const { a, b } = await pair();
    const r = await a.tool("site@win", "run", { machine: "wsl", shell: "bash", script: "yes | head -c 34000000", background: false });
    expect(r.isError).toBe(true);
    const bytes = Number(/^too_large: ответ (\d+) байт больше кадра рации \(32 МиБ\)/.exec(r.content[0].text!)?.[1]);
    expect(bytes).toBeGreaterThan(MAX_FRAME);
    const run = String(a.st.relay.frames("shell.run").at(-1)!.run);
    expect(b.st.journal().find((x) => x.ev === "run_end" && x.run === run)).toMatchObject({ state: "exit", code: 0, bytes: { stdout: 34_000_000 } });
    expect((await a.tool("site@win", "info", { machine: "wsl" })).isError).toBeUndefined();
  });

  // источник: принятый дизайн — tools: «offline — машины нет на связи»; «no_run — запуска нет»
  it("294 · отказ словом — текстом для модели: info машины не на связи — offline; wait неизвестного run — no_run", async () => {
    const { a } = await pair();
    const info = a.tool("site@win", "info", { machine: "mac" });
    // relay: машины mac нет — отказ offline
    const f = await until(() => a.st.relay.frames("shell.info").find((x) => x.machine === "mac"));
    a.st.relay.deliver({ type: "reply", id: f.id!, ok: false, error: "offline" });
    expect(await info).toEqual({ content: [{ type: "text", text: "offline: машины mac нет на связи" }], isError: true });
    expect(await a.tool("site@win", "wait", { machine: "wsl", run: "nope", timeout: 0 })).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/^no_run: /) }] });
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
    const t0 = Date.now();
    a.st.relay.deliver(roster(["win"]));
    expect(await call).toEqual({ content: [{ type: "text", text: "disconnected: связь с машиной wsl оборвалась, пока ход ждал; если её Host жив — итог отдаст wait по run" }], isError: true });
    expect(Date.now() - t0).toBeLessThan(1000);
    const up = await machine("wsl");
    expect(await up.req("shell.wait", { run, timeout: 0 })).toMatchObject({ ok: false, error: "no_run" });
  });
});

describe("shell", () => {
  it("вклад в query(): сервер MCP shell с инструментами info, run, wait, kill", async () => {
    const { st } = await machine("laptop");
    await st.open("site@laptop");
    const servers = st.query("site@laptop").options.mcpServers as Record<string, { name?: string }>;
    expect(Object.keys(servers)).toContain("shell");
  });
});

describe("shell: покрытие плана host-modules", { timeout: 30_000 }, () => {
  it("3077 · ждущий run и wait того же запуска — итог обоим в момент конца", async () => {
    // источник: чьё: код (shell.ts:2-3 «в момент конца итог получают все ждущие»)
    const { req } = await machine("laptop");
    const run = rid(3077);
    const sync = req("shell.run", { run, shell: "bash", script: "sleep 1; echo done", background: false });
    await until(() => existsSync(runDir(run)));
    const w = await req("shell.wait", { run, timeout: 10 });
    const s = await sync;
    expect(w.result).toMatchObject({ state: "exit", code: 0, stdout: "done\n" });
    expect(s.result).toMatchObject({ state: "exit", code: 0, stdout: "done\n" });
  });

  // на Windows spawn неисполняемого файла бросает EFTYPE синхронно — это не ветка «шелл не стартовал», а ловушка ядра
  it.skipIf(win)("3078 · шелл не стартовал — итог exit без кода, строка run_error (Linux)", async () => {
    // источник: чьё: код (shell.ts:242-246)
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
    // источник: чьё: код (shell.ts:173-175; host/core kernel.ts:461-463 — локальный запрос при остановке — shutting_down)
    const { st, tool } = await machine("laptop");
    await st.open("site@laptop");
    const bg = await tool("site@laptop", "run", { machine: "laptop", shell: "bash", script: "sleep 30", background: true, timeout: 60 });
    const run = /run (\w+)/.exec(bg.content[0].text!)![1];
    stands.splice(stands.indexOf(st), 1);
    await st.close();
    expect(st.journal().find((l) => l.ev === "run_message" && l.run === run)).toMatchObject({ kind: "refuse", word: "shutting_down" });
  });

  it.skipIf(!win)("3080 · через сутки папку держит процесс — итог забыт, причина run_forget в журнале (Windows)", async () => {
    // источник: чьё: код (shell.ts:139-148)
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

  it("3081 · info: на машине нет модуля shell — текст модели unknown_request", async () => {
    // источник: чьё: код (shell.ts:111)
    const { st, tool } = await machine("win");
    const recv = st.relay.receive.bind(st.relay);
    st.relay.receive = (ws, text) => {
      recv(ws, text);
      if (text === "ping") return;
      const f = JSON.parse(text) as Frame;
      if (f.type === "shell.info") queueMicrotask(() => st.relay.deliver({ type: "reply", id: f.id as string, ok: false, error: "unknown_request" } as Frame));
    };
    await st.open("site@win");
    const r = await tool("site@win", "info", { machine: "pc" });
    expect(r).toEqual({ content: [{ type: "text", text: "unknown_request: на машине pc нет модуля shell" }], isError: true });
  });
});
