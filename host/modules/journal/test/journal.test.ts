// Эталоны и стыки модуля journal на стенде Host: поддельные SDK, relay, keeper и часы; журнал — во временной папке.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stand } from "@switchboard/host";
import type { Manifest, Module } from "@switchboard/host";
import manifest from "../module.json" with { type: "json" };
import { make, records } from "../src/journal.ts";

const { module, msg, standHost, turn, until } = stand;
type Stand = stand.Stand;

let st: Stand | null = null;
const envHome = process.env.SWITCHBOARD_HOME;
afterEach(async () => {
  await st?.close();
  st = null;
  if (envHome === undefined) delete process.env.SWITCHBOARD_HOME;
  else process.env.SWITCHBOARD_HOME = envHome;
});

async function bench(extra: ReturnType<typeof module>[] = []) {
  st = await standHost({ modules: [{ manifest: manifest as Manifest, module: make() }, ...extra] });
  return st;
}

const mine = (s: Stand) => s.journal().filter((l) => l.who === "host-journal");

describe("эталоны journal", () => {
  it("96 · budget бросает на каждом событии хода: ровно одна запись stop module_failed; дальше не зовётся; ход дошёл до конца", async () => {
    let calls = 0;
    const budget: Module = {
      on: {
        event() {
          calls++;
          throw new TypeError("Cannot read properties of undefined (reading 'limit')");
        },
      },
    };
    const seen: string[] = [];
    const s = await bench([module("budget", budget), module("host-spy", { on: { event: (_s, m) => void seen.push(m.type) } })]);
    const sess = await s.open("site@laptop");
    const p = s.proc("site@laptop");
    // десять событий хода подряд
    for (let i = 0; i < 2; i++) turn(p);
    p.send(msg.state("running"));
    p.send(msg.result());
    await until(() => seen.length === 10);
    p.send(msg.state("idle"));
    await until(() => sess.state === "idle" && seen.length === 11);
    const stops = s.journal().filter((l) => l.kind === "stop");
    expect(stops).toHaveLength(1);
    expect(stops[0]).toMatchObject({ who: "core", ev: "module_failed", module: "budget", callsign: "site@laptop", word: "module_error" });
    expect(stops[0].why).toContain("Cannot read properties of undefined (reading 'limit')");
    expect(calls).toBe(1);
  });

  it("97 · session.history v1 при chat v2: contract_mismatch, refuse ядра с from, id и обеими версиями", async () => {
    const chat = module("host-chat", { requests: { "session.history": () => ({ messages: [], more: false }) } }, { provides: { "session.history": 2 } });
    const s = await bench([chat]);
    await s.open("site@laptop");
    const r = await s.relay.request({ type: "session.history", id: "h-3", v: 1, callsign: "site@laptop", before: null, limit: 50 });
    expect(r).toMatchObject({ ok: false, error: "contract_mismatch" });
    const l = s.journal().find((x) => x.word === "contract_mismatch");
    expect(l).toMatchObject({ kind: "refuse", who: "core", from: "panel-desk", id: "h-3" });
    expect(l!.why).toContain("запрошена v1, у host-chat v2");
  });

  it("98 · три api_retry 529 и result с ошибкой у site; cwd_unavailable у wiki", async () => {
    const s = await bench();
    await s.open("site@laptop");
    await s.open("wiki@laptop");
    const site = s.proc("site@laptop");
    for (let a = 1; a <= 3; a++) site.send({ type: "system", subtype: "api_retry", attempt: a, max_retries: 10, retry_delay_ms: 1000 * 2 ** a, error_status: 529, error: "overloaded", session_id: "s" });
    site.send(msg.result({ subtype: "error_during_execution", is_error: true, errors: ["API Error: 529 Overloaded\nстек…"] }));
    s.proc("wiki@laptop").send(msg.result({ subtype: "error_during_execution", is_error: true, startup_failure_reason: "cwd_unavailable", errors: ["папки нет"] }));
    await until(() => mine(s).length === 5);
    const siteLines = mine(s).filter((l) => l.callsign === "site@laptop");
    expect(siteLines.filter((l) => l.ev === "sdk.api_retry").map((l) => [l.kind, l.attempt, l.error_status])).toEqual([
      ["note", 1, 529],
      ["note", 2, 529],
      ["note", 3, 529],
    ]);
    expect(siteLines.find((l) => l.ev === "sdk.result")).toMatchObject({ kind: "stop", word: "error_during_execution", why: "ход остановлен: API Error: 529 Overloaded" });
    expect(mine(s).find((l) => l.callsign === "wiki@laptop")).toMatchObject({ kind: "stop", ev: "sdk.result", word: "cwd_unavailable" });
  });

  it("99 · machine.journal: since 14:00, kind stop — keeper и host по времени; limit 1 — ранняя и more, since = её t — вторая; файлы не изменились", async () => {
    const home = mkdtempSync(join(tmpdir(), "switchboard-journal-"));
    const dir = join(home, "journal");
    mkdirSync(dir);
    const L = (o: object) => JSON.stringify({ part: "host", machine: "laptop", ...o });
    const host = [
      L({ t: "2026-10-30T13:59:00.000Z", who: "core", kind: "stop", ev: "gate", why: "до since" }),
      L({ t: "2026-10-30T14:01:00.000Z", who: "core", kind: "note", ev: "host_start" }),
      L({ t: "2026-10-30T14:02:11.204Z", who: "core", kind: "stop", ev: "module_failed", word: "module_error", why: "budget" }),
      L({ t: "2026-10-30T14:03:00.000Z", who: "core", kind: "note", ev: "ready" }),
      L({ t: "2026-10-30T14:04:00.000Z", who: "core", kind: "refuse", ev: "request", word: "unknown_request", why: "x" }),
    ];
    const keeper = [
      JSON.stringify({ t: "2026-10-30T14:00:30.000Z", part: "keeper", machine: "laptop", who: "keeper", kind: "stop", ev: "host_exit", code: 1, why: "Host вышел с кодом 1" }),
      JSON.stringify({ t: "2026-10-30T14:00:31.000Z", part: "keeper", machine: "laptop", who: "keeper", kind: "note", ev: "host_start" }),
    ];
    writeFileSync(join(dir, "host-2026-10-30.jsonl"), host.join("\n") + "\n");
    writeFileSync(join(dir, "keeper-2026-10-30.jsonl"), keeper.join("\n") + "\n");
    const before = readFileSync(join(dir, "host-2026-10-30.jsonl"), "utf8") + readFileSync(join(dir, "keeper-2026-10-30.jsonl"), "utf8");
    process.env.SWITCHBOARD_HOME = home;
    const s = await bench();
    const ask = (o: object) => s.relay.request({ type: "machine.journal", v: 1, machine: "laptop", kind: ["stop"], ...o });
    const a = await ask({ since: "2026-10-30T14:00:00.000Z", limit: 50 });
    expect(a).toMatchObject({ ok: true, result: { more: false } });
    expect((a.result as { records: Array<{ ev: string; part: string }> }).records.map((r) => [r.part, r.ev])).toEqual([
      ["keeper", "host_exit"],
      ["host", "module_failed"],
    ]);
    const b = await ask({ since: "2026-10-30T14:00:00.000Z", limit: 1 });
    const br = b.result as { records: Array<{ t: string; ev: string }>; more: boolean };
    expect(br.records.map((r) => r.ev)).toEqual(["host_exit"]);
    expect(br.more).toBe(true);
    const c = await ask({ since: br.records[0].t, limit: 1 });
    expect((c.result as { records: Array<{ ev: string }>; more: boolean })).toMatchObject({ records: [{ ev: "module_failed" }], more: false });
    expect(readFileSync(join(dir, "host-2026-10-30.jsonl"), "utf8") + readFileSync(join(dir, "keeper-2026-10-30.jsonl"), "utf8")).toBe(before);
    expect(await ask({ since: "вчера", limit: 5 })).toMatchObject({ ok: false, error: "bad_frame" });
    expect(await ask({ since: "2026-10-30T14:00:00.000Z" })).toMatchObject({ ok: false, error: "bad_frame" });
  });
});

describe("journal: юнит и стыки", () => {
  it("env CLAUDE_CODE_STARTUP_FAILURE_RESULTS=1 — в процессе каждой сессии", async () => {
    const s = await bench();
    await s.open("site@laptop");
    expect(s.proc("site@laptop").env.CLAUDE_CODE_STARTUP_FAILURE_RESULTS).toBe("1");
  });

  it("system/init — note только первый у процесса; после перезапуска сессии — снова", async () => {
    const s = await bench();
    const sess = await s.open("site@laptop");
    const init = () => ({ ...msg.init(sess.info.session_id, "claude-opus-5"), claude_code_version: "2.1.311", cwd: "/w/site", permissionMode: "bypassPermissions" });
    s.proc("site@laptop").send(init());
    s.proc("site@laptop").send(init());
    await until(() => mine(s).length === 1);
    await sess.restart();
    s.proc("site@laptop").send(init());
    await until(() => mine(s).length === 2);
    expect(mine(s).map((l) => [l.kind, l.ev, l.why])).toEqual([
      ["note", "sdk.init", "claude 2.1.311 · claude-opus-5 · /w/site · bypassPermissions"],
      ["note", "sdk.init", "claude 2.1.311 · claude-opus-5 · /w/site · bypassPermissions"],
    ]);
  });

  it("таблица сообщение SDK → запись", () => {
    const one = (m: object, first = true) => records(m as never, first);
    expect(one({ type: "system", subtype: "init", claude_code_version: "2", model: "m", cwd: "/", permissionMode: "bypassPermissions", mcp_servers: [{ name: "jira", status: "failed" }, { name: "fleet", status: "connected" }] }).map((r) => [r.kind ?? "note", r.why])).toEqual([
      ["note", "claude 2 · m · / · bypassPermissions"],
      ["stop", "MCP-серверы не поднялись: jira"],
    ]);
    expect(one({ type: "system", subtype: "init" }, false)).toEqual([]);
    expect(one({ type: "result", subtype: "success", is_error: false })).toEqual([]);
    expect(one({ type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "five_hour", resetsAt: 1761836400 } })[0]).toMatchObject({ kind: "stop", ev: "sdk.rate_limit", rateLimitType: "five_hour" });
    expect(one({ type: "rate_limit_event", rate_limit_info: { status: "allowed" } })).toEqual([]);
    expect(one({ type: "auth_status", isAuthenticating: false, output: [], error: "bad code" })[0]).toMatchObject({ kind: "stop", ev: "sdk.auth_status" });
    expect(one({ type: "system", subtype: "status", status: null, compact_result: "failed", compact_error: "слишком длинно" })[0]).toMatchObject({ kind: "stop", ev: "sdk.compact" });
    expect(one({ type: "system", subtype: "permission_denied", tool_name: "Bash", decision_reason_type: "rule", decision_reason: "deny Bash(rm:*)", message: "нет" })[0]).toMatchObject({ kind: "refuse", word: "permission_denied", tool_name: "Bash", why: "Bash: deny Bash(rm:*)" });
    expect(one({ type: "system", subtype: "worker_shutting_down", reason: "host_exit" })[0]).toMatchObject({ ev: "sdk.worker_shutting_down", why: "host_exit" });
    expect(one({ type: "system", subtype: "informational", level: "warning", content: "осторожно" })[0]).toMatchObject({ ev: "sdk.informational", why: "осторожно" });
    expect(one({ type: "system", subtype: "informational", level: "info", content: "x" })).toEqual([]);
    expect(one({ type: "assistant", message: {} })).toEqual([]);
  });
});
