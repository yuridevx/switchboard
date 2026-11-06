// Леса границы «журнал и инциденты», журнал машины на Host: сообщения SDK — строками журнала машины, machine.journal — строки host и keeper из файлов.
// Снаружи — SDK, держатели, relay и часы стенда. Импорт — только контракты; исход — ответ, env процесса, строки журнала. Номер — эталон-источник; без номера — чьё: код.
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stand } from "@switchboard/host";
import type { Ctx, Host, Manifest } from "@switchboard/host";
import { make } from "../contract.ts";

const { msg, standHost, until } = stand;
type Stand = stand.Stand;

const stands: Stand[] = [];
const saved = process.env.SWITCHBOARD_HOME;
beforeEach(() => {
  process.env.SWITCHBOARD_HOME = mkdtempSync(join(tmpdir(), "switchboard-journal-sb-"));
});
afterEach(async () => {
  for (const s of stands.splice(0)) await s.close();
  if (saved === undefined) delete process.env.SWITCHBOARD_HOME;
  else process.env.SWITCHBOARD_HOME = saved;
});

const manifest = () => JSON.parse(readFileSync(join(import.meta.dirname, "..", "module.json"), "utf8")) as Manifest;
async function jbench() {
  const st = await standHost({ modules: [{ manifest: manifest(), module: make() }] });
  stands.push(st);
  return st;
}
const mine = (s: Stand) => s.journal().filter((l) => l.who === "host-journal");

describe("сбои из сообщений SDK", () => {
  it("env CLAUDE_CODE_STARTUP_FAILURE_RESULTS=1 — в процессе каждой сессии", async () => {
    // сессия агента, который гоняет тесты, могла оставить переменную в окружении: проверяем вклад модуля
    const was = process.env.CLAUDE_CODE_STARTUP_FAILURE_RESULTS;
    delete process.env.CLAUDE_CODE_STARTUP_FAILURE_RESULTS;
    try {
      const s = await jbench();
      await s.open("site@laptop");
      expect(s.proc("site@laptop").env.CLAUDE_CODE_STARTUP_FAILURE_RESULTS).toBe("1");
    } finally {
      if (was !== undefined) process.env.CLAUDE_CODE_STARTUP_FAILURE_RESULTS = was;
    }
  });

  it("system/init — note только первый у процесса; после перезапуска сессии — снова", async () => {
    const s = await jbench();
    const sess = await s.open("site@laptop");
    const init = () => ({ ...msg.init(sess.info.session_id, "claude-opus-5"), claude_code_version: "2.1.311", cwd: "/w/site", permissionMode: "bypassPermissions" });
    s.proc("site@laptop").send(init());
    s.proc("site@laptop").send(init());
    await until(() => mine(s).length === 1);
    await sess.restart();
    s.proc("site@laptop").send(init());
    await until(() => mine(s).length === 2);
    expect(mine(s).map((l) => [l.kind, l.ev, l.why, l.callsign, l.claude_code_version, l.model, l.cwd, l.permissionMode])).toEqual(
      Array(2).fill(["note", "sdk.init", "claude 2.1.311 · claude-opus-5 · /w/site · bypassPermissions", "site@laptop", "2.1.311", "claude-opus-5", "/w/site", "bypassPermissions"]),
    );
  });

  it("98 · три api_retry 529 и result с ошибкой у site; cwd_unavailable у wiki — у каждой сессии свои строки", async () => {
    const s = await jbench();
    await s.open("site@laptop");
    await s.open("wiki@laptop");
    const site = s.proc("site@laptop");
    for (let a = 1; a <= 3; a++) site.send({ type: "system", subtype: "api_retry", attempt: a, max_retries: 10, retry_delay_ms: 1000 * 2 ** a, error_status: 529, error: "overloaded", session_id: "s" });
    site.send(msg.result({ subtype: "error_during_execution", is_error: true, errors: ["API Error: 529 Overloaded\nстек…"] }));
    s.proc("wiki@laptop").send(msg.result({ subtype: "error_during_execution", is_error: true, startup_failure_reason: "cwd_unavailable", errors: ["папки нет"] }));
    await until(() => mine(s).length === 5);
    const siteLines = mine(s).filter((l) => l.callsign === "site@laptop");
    expect(siteLines.filter((l) => l.ev === "sdk.api_retry").map((l) => [l.kind, l.attempt, l.error_status, l.error])).toEqual([
      ["note", 1, 529, "overloaded"],
      ["note", 2, 529, "overloaded"],
      ["note", 3, 529, "overloaded"],
    ]);
    expect(siteLines.find((l) => l.ev === "sdk.result")).toMatchObject({ kind: "stop", word: "error_during_execution", why: "ход остановлен: API Error: 529 Overloaded" });
    expect(mine(s).find((l) => l.callsign === "wiki@laptop")).toMatchObject({ kind: "stop", ev: "sdk.result", word: "cwd_unavailable" });
  });

  const RESET = 1761836400;
  it.each([
    ["init: MCP не поднялся", { type: "system", subtype: "init", claude_code_version: "2", model: "m", cwd: "/", permissionMode: "p", mcp_servers: [{ name: "jira", status: "failed" }, { name: "fleet", status: "connected" }] }, [{ ev: "sdk.init", why: "claude 2 · m · / · p" }, { kind: "stop", ev: "sdk.init", why: "MCP-серверы не поднялись: jira", mcp_failed: ["jira"] }]],
    ["init: плагин с ошибкой", { type: "system", subtype: "init", claude_code_version: "2", model: "m", cwd: "/", permissionMode: "p", plugin_errors: [{ plugin: "x", type: "load", message: "нет" }] }, [{ ev: "sdk.init" }, { kind: "stop", ev: "sdk.init", why: "плагины: x: load — нет", plugin_errors: [{ plugin: "x", type: "load", message: "нет" }] }]],
    ["init: и MCP, и плагин", { type: "system", subtype: "init", claude_code_version: "2", model: "m", cwd: "/", permissionMode: "p", mcp_servers: [{ name: "a", status: "failed" }, { name: "b", status: "failed" }], plugin_errors: [{ plugin: "x", type: "t", message: "m" }] }, [{ ev: "sdk.init" }, { kind: "stop", why: "MCP-серверы не поднялись: a, b; плагины: x: t — m" }]],
    ["result: успех — строк нет", { type: "result", subtype: "success", is_error: false }, []],
    ["result: подтип ошибки без is_error", { type: "result", subtype: "error_max_turns", is_error: false, errors: ["предел ходов"] }, [{ kind: "stop", ev: "sdk.result", word: "error_max_turns", why: "ход остановлен: предел ходов" }]],
    ["result: успех с is_error", { type: "result", subtype: "success", is_error: true, result: "первая\nвторая" }, [{ kind: "stop", ev: "sdk.result", word: "is_error", why: "ход остановлен: первая" }]],
    ["api_retry без статуса", { type: "system", subtype: "api_retry", attempt: 2, max_retries: 5, retry_delay_ms: 1500 }, [{ ev: "sdk.api_retry", why: "попытка 2 из 5: нет ответа, пауза 1.5 с", retry_delay_ms: 1500 }]],
    ["лимит: отказ", { type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "five_hour", resetsAt: RESET } }, [{ kind: "stop", ev: "sdk.rate_limit", word: "rate_limit", why: `лимит аккаунта five_hour: отказ до ${new Date(RESET * 1000).toISOString()}`, rateLimitType: "five_hour", resetsAt: RESET }]],
    ["лимит: без вида и срока", { type: "rate_limit_event", rate_limit_info: { status: "rejected" } }, [{ kind: "stop", why: "лимит аккаунта —: отказ до —" }]],
    ["лимит: не отказ — строк нет", { type: "rate_limit_event", rate_limit_info: { status: "allowed" } }, []],
    ["вход не удался", { type: "auth_status", isAuthenticating: false, output: [], error: "bad code\nстек" }, [{ kind: "stop", ev: "sdk.auth_status", why: "вход аккаунта не удался: bad code" }]],
    ["вход без ошибки — строк нет", { type: "auth_status", isAuthenticating: true, output: [] }, []],
    ["сжатие не удалось", { type: "system", subtype: "status", status: null, compact_result: "failed", compact_error: "слишком длинно\nx" }, [{ kind: "stop", ev: "sdk.compact", why: "сжатие разговора не удалось: слишком длинно" }]],
    ["статус без сбоя сжатия — строк нет", { type: "system", subtype: "status", status: "compacting" }, []],
    ["отказ разрешения: причина", { type: "system", subtype: "permission_denied", tool_name: "Bash", decision_reason_type: "rule", decision_reason: "deny Bash(rm:*)", message: "нет" }, [{ kind: "refuse", ev: "sdk.permission_denied", word: "permission_denied", tool_name: "Bash", decision_reason_type: "rule", why: "Bash: deny Bash(rm:*)" }]],
    ["worker останавливается", { type: "system", subtype: "worker_shutting_down", reason: "host_exit" }, [{ ev: "sdk.worker_shutting_down", why: "host_exit" }]],
    ["предупреждение", { type: "system", subtype: "informational", level: "warning", content: "осторожно\nx" }, [{ ev: "sdk.informational", why: "осторожно" }]],
    ["informational не warning — строк нет", { type: "system", subtype: "informational", level: "info", content: "x" }, []],
    ["прочее — строк нет", { type: "assistant", message: { role: "assistant", content: [] } }, []],
  ])("сообщение SDK → строка журнала машины: %s", async (_n, m, want) => {
    const s = await jbench();
    await s.open("site@laptop");
    const p = s.proc("site@laptop");
    p.send(m);
    // метка конца: сообщение уже прошло
    p.send({ type: "system", subtype: "worker_shutting_down", reason: "конец" });
    await until(() => mine(s).some((l) => l.why === "конец"));
    const lines = mine(s).filter((l) => l.why !== "конец");
    expect(lines).toHaveLength(want.length);
    want.forEach((w, i) => expect(lines[i]).toMatchObject({ callsign: "site@laptop", kind: "note", ...w }));
  });
});

describe("machine.journal", () => {
  /** Папка данных Host со строками host и keeper за один день. */
  function folder(files: Record<string, object[]>) {
    const dir = join(process.env.SWITCHBOARD_HOME!, "journal");
    mkdirSync(dir, { recursive: true });
    for (const [name, lines] of Object.entries(files)) writeFileSync(join(dir, name), lines.map((l) => JSON.stringify(l)).join("\n") + "\n\n");
    return dir;
  }
  const H = (o: object) => ({ part: "host", machine: "laptop", who: "core", kind: "note", ...o });

  it("99 · since 14:00, kind stop — keeper, приложение и host по времени; part — одна часть; limit 1 — ранняя и more, since = её t — вторая; файлы не изменились", async () => {
    const keeper = [
      { t: "2026-10-30T14:00:30.000Z", part: "keeper", machine: "laptop", who: "keeper", kind: "stop", ev: "host_exit", code: 1, why: "Host вышел с кодом 1" },
      { t: "2026-10-30T14:00:31.000Z", part: "keeper", machine: "laptop", who: "keeper", kind: "note", ev: "host_start" },
      { t: "2026-10-30T14:00:40.000Z", part: "capture", machine: "laptop", who: "keeper", kind: "stop", ev: "part_exit", why: "capture 1.4.0 вышла сама: код 3" },
    ];
    const dir = folder({
      "host-2026-10-30.jsonl": [
        H({ t: "2026-10-30T13:59:00.000Z", kind: "stop", ev: "gate", why: "до since" }),
        H({ t: "2026-10-30T14:01:00.000Z", ev: "host_start" }),
        H({ t: "2026-10-30T14:02:11.204Z", kind: "stop", ev: "module_failed", word: "module_error", why: "budget" }),
        H({ t: "2026-10-30T14:04:00.000Z", kind: "refuse", ev: "request", word: "unknown_request", why: "x" }),
      ],
      "keeper-2026-10-30.jsonl": keeper,
      // ни host, ни keeper: не журнал машины
      "other-2026-10-30.jsonl": [H({ t: "2026-10-30T14:00:50.000Z", kind: "stop", ev: "чужой" })],
      // день раньше since: не читается
      "host-2026-10-29.jsonl": [H({ t: "2026-10-30T14:00:55.000Z", kind: "stop", ev: "прошлый_день" })],
    });
    const before = { host: readFileSync(join(dir, "host-2026-10-30.jsonl"), "utf8"), keeper: readFileSync(join(dir, "keeper-2026-10-30.jsonl"), "utf8") };
    const s = await jbench();
    const ask = (o: object) => s.relay.request({ type: "machine.journal", v: 2, machine: "laptop", kind: ["stop"], ...o });
    const a = await ask({ since: "2026-10-30T14:00:00.000Z", limit: 50 });
    expect(a).toMatchObject({ ok: true, result: { more: false } });
    expect((a.result as { records: Array<{ ev: string; part: string }> }).records.map((r) => [r.part, r.ev])).toEqual([
      ["keeper", "host_exit"],
      ["capture", "part_exit"],
      ["host", "module_failed"],
    ]);
    const only = async (part: string) => ((await ask({ since: "2026-10-30T14:00:00.000Z", limit: 50, part })).result as { records: Array<{ ev: string }> }).records.map((r) => r.ev);
    expect(await only("capture")).toEqual(["part_exit"]);
    expect(await only("keeper")).toEqual(["host_exit"]);
    expect(await only("host")).toEqual(["module_failed"]);
    const b = await ask({ since: "2026-10-30T14:00:00.000Z", limit: 1 });
    const br = b.result as { records: Array<{ t: string; ev: string }>; more: boolean };
    expect(br.records.map((r) => r.ev)).toEqual(["host_exit"]);
    expect(br.more).toBe(true);
    expect((await ask({ since: br.records[0].t, limit: 1 })).result).toMatchObject({ records: [{ ev: "part_exit" }], more: true });
    expect(readFileSync(join(dir, "host-2026-10-30.jsonl"), "utf8").startsWith(before.host)).toBe(true);
    expect(readFileSync(join(dir, "keeper-2026-10-30.jsonl"), "utf8")).toBe(before.keeper);
  });

  it("kind: строка без kind считается note; без фильтра — все; since не в полной записи времени — приводится", async () => {
    folder({ "host-2026-10-30.jsonl": [{ t: "2026-10-30T10:00:00.000Z", part: "host", ev: "без_вида" }, H({ t: "2026-10-30T10:01:00.000Z", kind: "refuse", ev: "отказ" })] });
    const s = await jbench();
    const evs = async (o: object) => ((await s.relay.request({ type: "machine.journal", v: 2, machine: "laptop", since: "2026-10-30T09:00:00Z", limit: 5, ...o })).result as { records: Array<{ ev: string }> }).records.map((r) => r.ev).filter((e) => ["без_вида", "отказ"].includes(e));
    expect(await evs({ kind: ["note"] })).toEqual(["без_вида"]);
    expect(await evs({ kind: ["refuse"] })).toEqual(["отказ"]);
    expect(await evs({})).toEqual(["без_вида", "отказ"]);
  });

  it("3014 · 3106 · session — строки одной сессии, и убранной тоже; строк после since нет — пусто; папки ещё нет — пусто", async () => {
    const s = await jbench();
    const ask = (o: object) => s.relay.request({ type: "machine.journal", v: 2, machine: "laptop", ...o });
    expect(await ask({ since: "2099-01-01T00:00:00.000Z", limit: 5 })).toMatchObject({ ok: true, result: { records: [], more: false } });
    folder({ "host-2026-10-30.jsonl": [H({ t: "2026-10-30T10:00:00.000Z", ev: "gone", callsign: "old@laptop" }), H({ t: "2026-10-30T10:01:00.000Z", ev: "other", callsign: "live@laptop" })] });
    const r = await ask({ session: "old@laptop", since: "2026-10-30T00:00:00.000Z", limit: 5 });
    expect((r.result as { records: Array<{ ev: string }> }).records.map((x) => x.ev)).toEqual(["gone"]);
  });

  it("more: записей ровно limit — нет; следующий день ещё не прочитан — есть", async () => {
    folder({ "host-2026-10-29.jsonl": [H({ t: "2026-10-29T10:00:00.000Z", kind: "stop", ev: "раньше" })], "keeper-2026-10-30.jsonl": [H({ t: "2026-10-30T10:00:00.000Z", kind: "stop", ev: "позже" })] });
    const s = await jbench();
    const ask = async (limit: number) => (await s.relay.request({ type: "machine.journal", v: 2, machine: "laptop", kind: ["stop"], since: "2026-10-29T00:00:00.000Z", limit })).result as { records: Array<{ ev: string }>; more: boolean };
    expect(await ask(2)).toMatchObject({ records: [{ ev: "раньше" }, { ev: "позже" }], more: false });
    expect(await ask(1)).toMatchObject({ records: [{ ev: "раньше" }], more: true });
  });

  it("строку ещё дописывают: читается всё до неё, ответ не отказ", async () => {
    const dir = folder({ "host-2026-10-30.jsonl": [H({ t: "2026-10-30T10:00:00.000Z", ev: "целая" })] });
    appendFileSync(join(dir, "host-2026-10-30.jsonl"), '{"t":"2026-10-30T10:01:00.000Z","ev":"недо');
    const s = await jbench();
    const r = await s.relay.request({ type: "machine.journal", v: 2, machine: "laptop", since: "2026-10-30T09:00:00.000Z", limit: 5 });
    expect(r).toMatchObject({ ok: true });
    expect((r.result as { records: Array<{ ev: string }> }).records.map((x) => x.ev)).toContain("целая");
    expect((r.result as { records: Array<{ ev: string }> }).records.map((x) => x.ev)).not.toContain("недо");
  });

  describe("чтение файлов — работа Host, у которого на одном потоке все сессии", () => {
    /** Запрос напрямую: сигнал остановки Host — вход контракта модуля. */
    function direct() {
      folder({ "host-2026-10-30.jsonl": [H({ t: "2026-10-30T10:00:00.000Z", ev: "строка" })] });
      const m = make();
      void m.start!({ dataDir: process.env.SWITCHBOARD_HOME! } as Host);
      return (signal: AbortSignal) => m.requests!["machine.journal"]({ type: "machine.journal", since: "2026-10-30T00:00:00.000Z", limit: 5 }, { signal } as Ctx);
    }

    it("пока файл читается, цикл событий Host идёт", async () => {
      const ask = direct();
      let turned = false;
      setImmediate(() => (turned = true));
      await ask(new AbortController().signal);
      expect(turned).toBe(true);
    });

    it("сигнал остановки Host обрывает чтение файлов", async () => {
      const ask = direct();
      await expect((async () => ask(AbortSignal.abort()))()).rejects.toMatchObject({ name: "AbortError" });
    });
  });

  it.each([
    ["нет limit", { since: "2026-10-30T14:00:00.000Z" }],
    ["limit 0", { since: "2026-10-30T14:00:00.000Z", limit: 0 }],
    ["since не время", { since: "вчера", limit: 5 }],
    ["kind не список", { since: "2026-10-30T14:00:00.000Z", limit: 5, kind: "stop" }],
    ["session не текст", { since: "2026-10-30T14:00:00.000Z", limit: 5, session: 5 }],
    ["part не текст", { since: "2026-10-30T14:00:00.000Z", limit: 5, part: 5 }],
  ])("вход отклонён: %s — bad_frame", async (_n, o) => {
    const s = await jbench();
    expect(await s.relay.request({ type: "machine.journal", v: 2, machine: "laptop", ...o })).toMatchObject({ ok: false, error: "bad_frame" });
  });
});
