// Эталоны модуля shell на стенде Host: поддельные SDK и relay, шеллы настоящие — bash (Git Bash на Windows),
// PowerShell где есть. Вторая машина — второй стенд: кадры между поддельными relay ходят по machine и to, как в рации.
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stand } from "@switchboard/host";
import type { Frame, Manifest } from "@switchboard/host";
import { machineOf } from "@switchboard/protocol";
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
    expect(j.find((x) => x.ev === "run_start")).toMatchObject({ shell: "bash", background: false, timeout: 120, line: "echo hi; echo err >&2; sleep 3 & exit 3" });
    expect(typeof j.find((x) => x.ev === "run_start")!.pid).toBe("number");
    expect(j.find((x) => x.ev === "run_end")).toMatchObject({ state: "exit", code: 3, bytes: { stdout: 3, stderr: 4 } });
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
    await req("shell.run", { run, shell: "bash", script: "for i in 1 2 3 4 5; do echo line$i; sleep 1; done", background: true, timeout: 30 });
    await new Promise((res) => setTimeout(res, 2500));
    const t0 = Date.now();
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
});

describe("shell", () => {
  it("вклад в query(): сервер MCP shell с инструментами info, run, wait, kill", async () => {
    const { st } = await machine("laptop");
    await st.open("site@laptop");
    const servers = st.query("site@laptop").options.mcpServers as Record<string, { name?: string }>;
    expect(Object.keys(servers)).toContain("shell");
  });
});
