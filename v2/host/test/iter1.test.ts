// Эталоны первой итерации: функции старой системы, которых не хватало в Host v2.
import { existsSync, mkdirSync, mkdtempSync, appendFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ok } from "@sb/protocol";
import { make as accounts } from "../src/modules/accounts/accounts.ts";
import { folders } from "../src/modules/accounts/links.ts";
import { DOING_GAP_MS, make as chat, peopleOnly } from "../src/modules/chat/chat.ts";
import { make as incidents } from "../src/modules/incidents/incidents.ts";
import { make as machine } from "../src/modules/machine/machine.ts";
import { make as points, projectDir } from "../src/modules/points/points.ts";
import { make as profiles } from "../src/modules/profiles/profiles.ts";
import { make as proxy } from "../src/modules/proxy/proxy.ts";
import { make as remote } from "../src/modules/remote/remote.ts";
import { make as shell } from "../src/modules/shell/shell.ts";
import { FakeHolders, stand, tick, until, type Stand } from "../stand/index.ts";

let st: Stand | undefined;
const servers: Server[] = [];
afterEach(async () => {
  await st?.stop();
  st = undefined;
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise((r) => s.close(r));
  }
});

const PULT = "pult~yuri@example.com";
const PHONE = "phone~yuri@example.com";
const CS = "site@laptop";
const USAGE = "usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET";

/** Локальный сервер: хранилище блоков. */
async function server(answer: () => { status?: number; body?: Buffer | string } = () => ({})): Promise<{ url: string; seen: Array<{ method: string; url: string }> }> {
  const seen: Array<{ method: string; url: string }> = [];
  const s = createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      seen.push({ method: req.method!, url: req.url! });
      const a = answer();
      res.writeHead(a.status ?? 200).end(a.body ?? "{}");
    });
  });
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(s.address() as { port: number }).port}`, seen };
}

function homeWithAccounts(names: string[], limits: Record<string, unknown> = {}, slots: Record<string, string[]> = { main: names }): string {
  const home = mkdtempSync(join(tmpdir(), "sb2-host-"));
  mkdirSync(join(home, "store"), { recursive: true });
  const book = { accounts: Object.fromEntries(names.map((n) => [n, { login: "ok", plan: "max", limits: limits[n] ?? {} }])), slots };
  writeFileSync(join(home, "store", "host-accounts.json"), JSON.stringify({ machine: book }));
  const dirs = folders(home);
  for (const n of names) mkdirSync(dirs.accDir(n), { recursive: true });
  // у каждой очереди на диске — ссылка на первого по порядку
  for (const [slot, order] of Object.entries(slots)) symlinkSync(dirs.accDir(order[0]!), (mkdirSync(join(home, "slots"), { recursive: true }), dirs.slotDir(slot)), process.platform === "win32" ? "junction" : "dir");
  return home;
}

const events = (s: Stand) => s.link.of("session.events").flatMap((f) => f.events as any[]);

describe("ядро: открытие и документ", () => {
  it("number — первый свободный номер; mkdir создаёт папку; resume продолжает разговор по id; fork без resume — отказ", async () => {
    st = await stand();
    const to = "@laptop";
    expect((await st.request("session.open", { to, spec: { name: "site", cwd: st.dir }, number: true })).result).toMatchObject({ callsign: "site-1@laptop" });
    expect((await st.request("session.open", { to, spec: { name: "site", cwd: st.dir }, number: true })).result).toMatchObject({ callsign: "site-2@laptop" });
    const dir = join(st.dir, "new", "deep");
    expect(await st.request("session.open", { to, spec: { name: "lost", cwd: dir } })).toMatchObject({ ok: false, error: "bad_dir" });
    expect((await st.request("session.open", { to, spec: { name: "made", cwd: dir }, mkdir: true })).ok).toBe(true);
    expect(existsSync(dir)).toBe(true);
    expect((await st.request("session.open", { to, spec: { name: "old", cwd: st.dir }, resume: "conv-1" })).ok).toBe(true);
    expect(st.kernel.sessions.get("old@laptop")!.rec.sessionId).toBe("conv-1");
    expect((st.sdk.last("old@laptop")!.options as any).resume).toBe("conv-1");
    expect(await st.request("session.open", { to, spec: { name: "x", cwd: st.dir }, fork: true })).toMatchObject({ ok: false, error: "bad_spec" });
    // разговор, который уже ведёт сессия, второй сессией не открывается — только копией
    expect(await st.request("session.open", { to, spec: { name: "twin", cwd: st.dir }, resume: "conv-1" })).toMatchObject({ ok: false, error: "conversation_taken" });
    expect(st.kernel.sessions.has("twin@laptop")).toBe(false);
    expect((await st.request("session.open", { to, spec: { name: "copy", cwd: st.dir }, resume: "conv-1", fork: true })).ok).toBe(true);
    expect(st.kernel.sessions.get("copy@laptop")!.rec.sessionId).not.toBe("conv-1");
  });

  it("заголовок при открытии — из первого сообщения: в опциях запуска и в строке", async () => {
    st = await stand();
    await st.request("session.open", { to: "@laptop", spec: { name: "t", cwd: st.dir }, prompt: "Почини шапку сайта\nподробности ниже" });
    expect((st.sdk.last("t@laptop")!.options as any).title).toBe("Почини шапку сайта");
    expect(st.link.rows("t@laptop").at(-1)!.row).toMatchObject({ title: "Почини шапку сайта" });
  });

  it("session.update: fast, style, thinking — настройками Claude сразу; title — переименованием; cwd — после хода; ответ называет now и later", async () => {
    st = await stand();
    const { s } = await st.open("site");
    const other = join(st.dir, "other");
    mkdirSync(other);
    const first = st.sdk.last(CS)!;
    const r = await st.request("session.update", { to: CS, patch: { model: "m2", fast: true, style: "short", thinking: false, title: "Новый заголовок", cwd: other } });
    expect(r.result).toMatchObject({ later: ["cwd"] });
    expect((r.result as any).now.sort()).toEqual(["fast", "model", "style", "thinking", "title"]);
    expect(first.calls.find((c) => c.name === "applyFlagSettings")!.args[0]).toEqual({ fastMode: true, outputStyle: "short", alwaysThinkingEnabled: false });
    expect(first.calls.find((c) => c.name === "renameSession")!.args[0]).toBe("Новый заголовок");
    expect(s.row().title).toBe("Новый заголовок");
    await until(() => st!.sdk.of(CS).length === 2 && s.state === "idle", 5000, "перезапуск с новой папкой");
    expect(st.sdk.last(CS)!.options).toMatchObject({ cwd: other, settings: { fastMode: true, outputStyle: "short", alwaysThinkingEnabled: false } });
  });

  it("режим auto идёт в опции запуска; session.call: расход, правила, сжатие; сведения — и у остановленной", async () => {
    st = await stand();
    const { proc, q } = await st.open("site", { mode: "auto" });
    expect((q.options as any).permissionMode).toBe("auto");
    await st.request("session.call", { to: CS, method: "usage" });
    await st.request("session.call", { to: CS, method: "permissionRules" });
    expect(q.calls.map((c) => c.name)).toEqual(expect.arrayContaining([USAGE, "listPermissionRules"]));
    await st.request("session.call", { to: CS, method: "compact" });
    await until(() => proc.inputs.some((i) => i.message.content === "/compact"), 5000, "команда сжатия во вводе");
    await st.request("session.stop", { to: CS });
    expect((await st.request("session.call", { to: CS, method: "getSessionInfo" })).ok).toBe(true);
    expect(await st.request("session.call", { to: CS, method: "interrupt" })).toMatchObject({ ok: false, error: "stopped" });
  });

  it("session.remove с after_turn посреди хода: сессия уходит после его конца", async () => {
    st = await stand();
    const { proc, s } = await st.open("site");
    proc.send({ type: "system", subtype: "session_state_changed", state: "running" });
    await until(() => s.state === "busy", 5000, "ход");
    const r = await st.request("session.remove", { to: CS, after_turn: true }, CS);
    expect(r.result).toEqual({ after_turn: true });
    expect(st.kernel.sessions.has(CS)).toBe(true);
    proc.send({ type: "result", subtype: "success", result: "готово" });
    proc.send({ type: "system", subtype: "session_state_changed", state: "idle" });
    await until(() => !st!.kernel.sessions.has(CS), 5000, "сессия убрана после хода");
    expect(st.link.rows(CS).at(-1)!.row).toBeNull();
  });
});

describe("пара", () => {
  it("pair открывает ведомого <имя>-wing с тем же документом; в строке ведомого — ведущий; весть ведущему; вторая пара и пара в паре — отказ; wing: null снимает ведомого", async () => {
    st = await stand({ modules: [chat()] });
    const r = await st.request("session.open", { to: "@laptop", spec: { name: "lead", cwd: st.dir, model: "m1" }, pair: true });
    expect(r.result).toEqual({ callsign: "lead@laptop", wing: "lead-wing@laptop" });
    const lead = st.kernel.sessions.get("lead@laptop")!;
    const wing = st.kernel.sessions.get("lead-wing@laptop")!;
    expect(lead.rec.spec.wing).toBe("lead-wing@laptop");
    expect(wing.rec.spec).toMatchObject({ parent: "lead@laptop", model: "m1", cwd: st.dir });
    expect(st.link.rows("lead-wing@laptop").at(-1)!.row).toMatchObject({ lead: "lead@laptop" });
    await until(() => st!.proc("lead@laptop").inputs.some((i) => String(i.message.content).includes("Ведомый lead-wing@laptop открыт")), 5000, "весть ведущему");
    expect(await st.request("session.update", { to: "lead@laptop", patch: {}, pair: true })).toMatchObject({ ok: false, error: "has_wing" });
    expect(await st.request("session.update", { to: "lead-wing@laptop", patch: {}, pair: true })).toMatchObject({ ok: false, error: "pair_inside" });
    expect((await st.request("session.update", { to: "lead@laptop", patch: { wing: null } })).ok).toBe(true);
    expect(st.kernel.sessions.has("lead-wing@laptop")).toBe(false);
    expect(lead.rec.spec.wing).toBeUndefined();
  });

  it("ведомый остановился со сбоем — ведущий узнаёт", async () => {
    st = await stand({ modules: [chat()] });
    await st.request("session.open", { to: "@laptop", spec: { name: "lead", cwd: st.dir }, pair: true });
    const wing = st.kernel.sessions.get("lead-wing@laptop")!;
    st.holders.failInitNext = 1;
    st.proc("lead-wing@laptop").exit(1, "упал");
    await until(() => st!.holders.procs.get("lead-wing@laptop")?.failInit, 5000, "неготовый процесс");
    st.holders.procs.get("lead-wing@laptop")!.exit(1, "не поднялся");
    await until(() => wing.state === "failed", 5000, "failed");
    await until(() => st!.proc("lead@laptop").inputs.some((i) => String(i.message.content).includes("остановился со сбоем")), 5000, "весть об обрыве");
  });
});

describe("chat: строка и лента", () => {
  it("ход на 1 000 шагов инструментов: строка «чем занят» меняется не чаще раза в DOING_GAP_MS", async () => {
    st = await stand({ modules: [chat()] });
    await st.open("site");
    const before = st.link.rows(CS).length;
    const steps = Array.from({ length: 1000 }, (_, i) => ({ type: "assistant", uuid: `u${i}`, message: { content: [{ type: "tool_use", id: `t${i}`, name: "Read", input: { file_path: `src/f${i}.ts` } }] } }));
    const t0 = Date.now();
    await st.turn(CS, steps, "сделано");
    await tick(20);
    const rows = st.link.rows(CS).slice(before).map((f) => f.row as any);
    const doing = rows.filter((r, i) => r.doing && r.doing !== rows[i - 1]?.doing);
    expect(doing.length).toBeGreaterThanOrEqual(1);
    expect(doing.length).toBeLessThanOrEqual(1 + Math.floor((Date.now() - t0) / DOING_GAP_MS));
    expect(doing[0]!.doing).toBe("Чтение src/f0.ts");
    expect(rows.length).toBeLessThanOrEqual(2 + doing.length);
    expect(rows.at(-1)).toMatchObject({ state: "idle" });
    expect(rows.at(-1).doing).toBeUndefined();
  });

  it("сжатие контекста видно в строке, пока идёт", async () => {
    st = await stand({ modules: [chat()] });
    const { proc, s } = await st.open("site");
    proc.send({ type: "system", subtype: "session_state_changed", state: "running" });
    await until(() => s.state === "busy", 5000, "ход");
    proc.send({ type: "system", subtype: "status", status: "compacting" });
    await until(() => (st!.link.rows(CS).at(-1)!.row as any).compacting === true, 5000, "сжатие в строке");
    proc.send({ type: "system", subtype: "status", status: null });
    await until(() => (st!.link.rows(CS).at(-1)!.row as any).compacting === undefined, 5000, "сжатие кончилось");
  });

  it("лента: зритель называет последний номер и получает пропущенное; пропущенного нет в памяти — gap", async () => {
    st = await stand({ modules: [chat()] });
    const { proc } = await st.open("site");
    expect((await st.request("session.watch", { to: CS }, PULT)).result).toEqual({ seq: 0 });
    for (const uuid of ["a1", "a2", "a3"]) proc.send({ type: "assistant", uuid, message: { content: [] } });
    await until(() => events(st!).length === 3, 5000, "три события");
    const again = await st.request("session.watch", { to: CS, after: 1 }, PHONE);
    expect(again.result).toMatchObject({ seq: 3 });
    expect((again.result as any).events.map((e: any) => e.uuid)).toEqual(["a2", "a3"]);
    expect((await st.request("session.watch", { to: CS, after: 3 }, PHONE)).result).toEqual({ seq: 3 });
    for (let i = 0; i < 2005; i++) proc.send({ type: "assistant", uuid: `b${i}`, message: { content: [] } });
    await until(() => events(st!).length === 2008, 10_000, "поток");
    const far = await st.request("session.watch", { to: CS, after: 1 }, PHONE);
    expect(far.result).toMatchObject({ seq: 2008, gap: true });
    expect((far.result as any).events).toBeUndefined();
  }, 30_000);

  it("своё сообщение занятой сессии: в очереди — статус и список у зрителя; отмена; ход взял — статус taken; приоритет доходит до SDK", async () => {
    st = await stand({ modules: [chat()] });
    const { proc, s } = await st.open("site");
    await st.request("session.watch", { to: CS }, PULT);
    proc.send({ type: "system", subtype: "session_state_changed", state: "running" });
    await until(() => s.state === "busy", 5000, "ход");
    const m = await st.request("message", { to: CS, text: "ещё одно", priority: "later" }, PULT);
    expect(m.result).toMatchObject({ queued: true, uuid: expect.any(String) });
    const uuid = (m.result as any).uuid as string;
    await until(() => proc.inputs.length === 1, 5000, "ввод");
    expect(proc.inputs[0]!.priority).toBe("later");
    await until(() => events(st!).some((e) => e.type === "message.status" && e.uuid === uuid && e.status === "queued"), 5000, "статус queued");
    expect((await st.request("session.watch", { to: CS }, PHONE)).result).toMatchObject({ queued: [{ uuid, from: PULT, text: "ещё одно" }] });
    expect((await st.request("message.cancel", { to: CS, uuid }, PULT)).result).toEqual({ cancelled: true });
    expect(st.sdk.last(CS)!.calls.find((c) => c.name === "cancelAsyncMessage")!.args).toEqual([uuid]);
    await until(() => events(st!).some((e) => e.type === "message.status" && e.uuid === uuid && e.status === "cancelled"), 5000, "статус cancelled");
    expect((await st.request("message.cancel", { to: CS, uuid }, PULT)).result).toEqual({ cancelled: false });
    // вход отмены один: проходом session.call её нет
    expect(await st.request("session.call", { to: CS, method: "cancelMessage", args: { uuid } }, PULT)).toMatchObject({ ok: false });
    const second = ((await st.request("message", { to: CS, text: "и ещё" }, PULT)).result as any).uuid as string;
    proc.send({ type: "system", subtype: "status", user_message_uuids: [second] });
    await until(() => events(st!).some((e) => e.type === "message.status" && e.uuid === second && e.status === "taken"), 5000, "статус taken");
    expect((await st.request("session.watch", { to: CS }, PHONE)).result).not.toHaveProperty("queued");
  });

  it("сообщение человека и сессии приходит зрителям сразу; итог хода — в ленте и в истории за последней записью хода", async () => {
    st = await stand({ modules: [chat()] });
    const { proc, s } = await st.open("site");
    await st.request("session.watch", { to: CS }, PULT);
    const uuid = ((await st.request("message", { to: CS, text: "привет" }, PULT)).result as any).uuid as string;
    await until(() => events(st!).some((e) => e.type === "user" && e.uuid === uuid), 5000, "сообщение в ленте");
    expect(events(st).find((e) => e.uuid === uuid)).toMatchObject({ type: "user", from: PULT, message: { role: "user", content: "привет" } });
    proc.send({ type: "system", subtype: "session_state_changed", state: "running" });
    proc.send({ type: "assistant", uuid: "a1", message: { content: [{ type: "text", text: "ответ" }] } });
    proc.send({ type: "result", subtype: "success", uuid: "r1", result: "ответ", duration_ms: 7000, num_turns: 1, total_cost_usd: 0.03, usage: { input_tokens: 25000 } });
    proc.send({ type: "system", subtype: "session_state_changed", state: "idle" });
    await until(() => events(st!).some((e) => e.type === "result" && e.uuid === "r1"), 5000, "итог хода в ленте");
    await until(() => s.state === "idle", 5000, "ход кончился");
    // файл разговора итога не хранит: история отдаёт его за последней записью хода
    const said = [{ type: "user", uuid, message: { content: "привет" } }, { type: "assistant", uuid: "a1", message: { content: [{ type: "text", text: "ответ" }] } }];
    (st.sdk as any).functions = new Proxy({}, { get: (_t, name) => async () => (name === "getSessionMessages" ? said : {}) });
    const h = ((await st.request("session.history", { to: CS })).result as any).events as any[];
    expect(h.map((e) => e.type)).toEqual(["user", "assistant", "result"]);
    expect(h[2]).toMatchObject({ uuid: "r1", duration_ms: 7000, num_turns: 1, total_cost_usd: 0.03, usage: { input_tokens: 25000 } });
    expect(h[2].result).toBeUndefined();
    // сообщение сессии — с разобранным отправителем
    const from = ((await st.request("message", { to: CS, text: "я закончила" }, "docs@server")).result as any).uuid as string;
    await until(() => events(st!).some((e) => e.uuid === from), 5000, "сообщение сессии в ленте");
    expect(events(st).find((e) => e.uuid === from)).toMatchObject({ type: "user", peer: { from: "docs@server", text: "я закончила" } });
  });

  it("форма сервера MCP: ответ { action: accept, content } доходит до сервера значениями полей", async () => {
    st = await stand({ modules: [chat()] });
    const { proc } = await st.open("site");
    const asked = proc.elicit({ serverName: "почта", message: "Нужны данные сервера", requestedSchema: { type: "object", properties: { server: { type: "string" }, port: { type: "number" } } } });
    const ask = await until(() => (st!.link.rows(CS).at(-1)!.row as any).ask, 5000, "вопрос-форма в строке");
    expect(ask).toMatchObject({ kind: "form", text: "Нужны данные сервера" });
    expect((await st.request("answer", { to: CS, ask: ask.id, answer: { action: "accept", content: { server: "smtp.example.com", port: 587 } } }, PULT)).ok).toBe(true);
    expect(await asked).toEqual({ action: "accept", content: { server: "smtp.example.com", port: 587 } });
  });

  it("история «только люди»: сообщения людей и им, вопросы и ответы; сообщения сессий и работа — нет", () => {
    const all = [
      { type: "user", message: { content: "привет" } },
      { type: "user", peer: { from: "docs@server" }, message: { content: "…" } },
      { type: "user", peer: { from: "phone~a@b.c" }, message: { content: "…" } },
      { type: "assistant", message: { content: [{ type: "text", text: "думаю" }] } },
      { type: "assistant", message: { content: [{ type: "tool_use", id: "q1", name: "AskUserQuestion", input: {} }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "q1", content: "main" }] } },
      { type: "assistant", message: { content: [{ type: "tool_use", id: "s1", name: "mcp__fleet__reach_send", input: { to: "~a@b.c", text: "готово" } }] } },
      { type: "system" },
    ];
    expect(peopleOnly(all).map((m) => all.indexOf(m))).toEqual([0, 2, 4, 5, 6]);
  });
});

describe("accounts", () => {
  it("лимит исчерпан: у очереди и у её сессии — час сброса; «сменить сейчас» ставит названный аккаунт, без запаса — отказ", async () => {
    const at = Math.floor(Date.now() / 1000);
    const home = homeWithAccounts(["a@example.com", "b@example.com"], {
      "a@example.com": { five_hour: { utilization: 1, resetsAt: at + 600, at } },
      "b@example.com": { five_hour: { utilization: 1, resetsAt: at + 900, at } },
    });
    st = await stand({ home, modules: [accounts()] });
    st.services.handlers["keys.list"] = () => ({ keys: [] });
    const list = (await st.request("account.list", { to: "@laptop" })).result as any;
    // «ждёт сброса» — у очереди: годность аккаунта зависит от её вида
    expect(list.accounts[0].wait).toBeUndefined();
    expect(list.slots).toEqual([{ name: "main", model: "fable", order: ["a@example.com", "b@example.com"], account: "a@example.com", wait: (at + 600) * 1000, sessions: 0 }]);
    await st.open("site");
    expect(st.link.rows(CS).at(-1)!.row).toMatchObject({ account: "a@example.com", wait: (at + 600) * 1000 });
    expect(await st.request("slot.swap", { to: "@laptop", slot: "main" })).toMatchObject({ ok: false, error: "no_reserve" });
    expect((await st.request("slot.swap", { to: "@laptop", slot: "main", account: "b@example.com" })).result).toEqual({ account: "b@example.com" });
    expect(folders(home).inSlot("main")).toBe("b@example.com");
    expect(st.link.rows(CS).at(-1)!.row).toMatchObject({ account: "b@example.com" });
    expect(st.services.of("ledger.add").some((f) => f.what === "account.swapped")).toBe(true);
    expect(await st.request("slot.swap", { to: "@laptop", slot: "main", account: "nope@example.com" })).toMatchObject({ ok: false, error: "no_account" });
  });

  it("ключ флота: переменные и настройки ключа идут в запуск сессии; провайдер и адрес — в списке", async () => {
    st = await stand({ modules: [accounts()] });
    st.services.handlers["keys.value"] = () => ({ value: "sk-one", provider: "anthropic", base: "https://api.example.com", models: { opus: "big-1", haiku: "" }, window: 200000, env: { CLAUDE_CODE_DISABLE_1M_CONTEXT: "1" }, settings: { autoCompactWindow: 200000 } });
    st.services.handlers["keys.list"] = () => ({ keys: [{ name: "team-key", provider: "anthropic", base: "https://api.example.com", model: "big-1", at: 1, tail: "…abcd" }] });
    const { q } = await st.open("site", { slot: "team-key" });
    expect((q.options as any).env).toMatchObject({ ANTHROPIC_DEFAULT_OPUS_MODEL: "big-1", CLAUDE_CODE_AUTO_COMPACT_WINDOW: "200000", CLAUDE_CODE_DISABLE_1M_CONTEXT: "1", ANTHROPIC_API_KEY: "fleet" });
    expect((q.options as any).env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBeUndefined();
    const route = await (st.kernel.mods.find((m) => m.name === "host-accounts")!.api as any).keyRoute("team-key");
    expect(route).toMatchObject({ to: "https://api.example.com", key: "sk-one", env: { ANTHROPIC_DEFAULT_OPUS_MODEL: "big-1", ANTHROPIC_API_KEY: "fleet" } });
    expect((q.options as any).settings).toMatchObject({ autoCompactWindow: 200000 });
    const list = (await st.request("account.list", { to: "@laptop" })).result as any;
    expect(list.accounts).toContainEqual({ id: "team-key", kind: "key", ok: true, sessions: 1, provider: "anthropic", base: "https://api.example.com", model: "big-1" });
  });
});

describe("points", () => {
  it("с прошлой точки ничего не изменилось — новая не пишется; сбой точки виден в строке и уходит с удачной; ведущий пары не отпускается; проба папки подъёма ничего не открывает", async () => {
    const store = await server();
    st = await stand({ modules: [points()] });
    const { s } = await st.open("site", { backup: true });
    const dir = projectDir(s.rec.cwd);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${s.rec.sessionId}.jsonl`);
    const line = (n: number) => JSON.stringify({ type: "user", uuid: `u${n}`, message: { content: `шаг ${n}` } }) + "\n";
    writeFileSync(file, line(1));
    let puts = 0;
    const good = (f: any) => {
      puts++;
      return f.commit ? { upload: {}, done: true } : { upload: Object.fromEntries((f.files as any[]).flatMap((x) => x.blocks).map((h: string) => [h, `${store.url}/b/${h}`])), done: false };
    };
    st.services.handlers["points.put"] = good;
    const first = (await st.request("points.save", { to: CS })).result as any;
    expect(puts).toBe(2);
    expect((await st.request("points.save", { to: CS })).result).toEqual({ point: first.point, same: true });
    expect(puts).toBe(2);
    appendFileSync(file, line(2));
    st.services.handlers["points.put"] = () => {
      throw { word: "store_failed", message: "архив не отвечает" };
    };
    expect(await st.request("points.save", { to: CS })).toMatchObject({ ok: false, error: "store_failed" });
    expect(st.link.rows(CS).at(-1)!.row).toMatchObject({ archiveError: expect.stringContaining("архив не отвечает") });
    st.services.handlers["points.put"] = good;
    expect((await st.request("points.save", { to: CS })).result).toMatchObject({ point: expect.stringMatching(/^p/) });
    expect((st.link.rows(CS).at(-1)!.row as any).archiveError).toBeUndefined();

    s.rec.spec = { ...s.rec.spec, wing: "x@laptop" };
    expect(await st.request("points.save", { to: CS, move: true })).toMatchObject({ ok: false, error: "has_wing" });

    st.services.handlers["points.get"] = () => ({ session: { sid: "sid-old", machine: "server", callsign: "docs@server", cwd: st!.dir, points: 1, last: 1 }, point: { point: "p1", at: 1 }, files: [] });
    const check = await st.request("points.raise", { to: "@laptop", sid: "sid-old", name: "docs-copy", dryRun: true });
    expect(check.result).toMatchObject({ check: { folder: "nogit", files: 0, sessions: [] } });
    expect(st.kernel.sessions.has("docs-copy@laptop")).toBe(false);
  });

  it("перенос: прежняя машина снимает точку и останавливает сессию; не поднялась здесь — запускает снова; блока нет — missing", async () => {
    const gone = await server(() => ({ status: 404 }));
    st = await stand({ modules: [points()] });
    const asked: string[] = [];
    st.link.answers["points.save"] = (f) => (asked.push(`save ${String(f.to)} move=${String(f.move)}`), ok(f.id!, { point: "p9" }));
    st.link.answers["session.start"] = (f) => (asked.push(`start ${String(f.to)}`), ok(f.id!, {}));
    st.link.answers["session.remove"] = (f) => (asked.push(`remove ${String(f.to)}`), ok(f.id!, {}));
    const got: any[] = [];
    st.services.handlers["points.get"] = (f) => {
      got.push(f.point);
      return { session: { sid: "sid-x", machine: "server", callsign: "docs@server", cwd: st!.dir, points: 2, last: 1 }, point: { point: "p9", at: 1 }, files: [{ path: "sid-x.jsonl", size: 5, blocks: [{ hash: "0".repeat(64), url: `${gone.url}/b` }] }] };
    };
    const r = await st.request("points.raise", { to: "@laptop", sid: "sid-x", move: true });
    expect(r).toMatchObject({ ok: false, error: "missing" });
    expect(got).toEqual([undefined, "p9"]);
    expect(asked).toEqual(["save docs@server move=true", "start docs@server"]);
    expect(st.kernel.sessions.size).toBe(0);
  });
});

describe("shell", () => {
  it("ввод скрипта, раздельные stdout и stderr, файлы из $SB_OUT, предел работы — timeout; оболочки с путём и версией", async () => {
    st = await stand({ modules: [shell({ root: mkdtempSync(join(tmpdir(), "sb2-shell-")) })] });
    const script = 'import fs from "node:fs";\nfs.writeFileSync(process.env.SB_OUT + "/r.txt", "итог");\nprocess.stderr.write("err!");\nprocess.stdin.on("data", (d) => process.stdout.write("in:" + d));';
    const done = (await st.request("shell.run", { to: "@laptop", shell: "node", script, stdin: "привет", wait: 30 })).result as any;
    expect(done).toMatchObject({ state: "done", code: 0, stdout: "in:привет", stderr: "err!", ms: expect.any(Number) });
    expect(done.out).toContain("in:привет");
    expect(done.out).toContain("err!");
    expect(done.files).toEqual([{ name: "r.txt", size: Buffer.byteLength("итог"), base64: Buffer.from("итог").toString("base64") }]);
    const late = (await st.request("shell.run", { to: "@laptop", shell: "node", script: "setTimeout(() => {}, 60000)", timeout: 1, wait: 40 })).result as any;
    expect(late).toMatchObject({ state: "timeout" });
    expect(late.code).toBeUndefined();
    const info = (await st.request("shell.info", { to: "@laptop" })).result as any;
    expect(info.found).toContainEqual({ shell: "node", path: process.execPath, version: expect.any(String) });
  }, 60_000);
});

describe("incidents", () => {
  it("виды — из настроек флота: добавка к промпту и кого позвать; порт 0 — настоящий порт; вложения идут во ввод; причина недоставки — в списке; вид — в строке сессии", async () => {
    const home = mkdtempSync(join(tmpdir(), "sb2-host-"));
    const work = join(home, "work");
    mkdirSync(work, { recursive: true });
    st = await stand({ home, modules: [chat(), incidents()], config: { "host-incidents": { port: 0 } } });
    st.services.handlers["prefs.get"] = () => ({ values: { "incidents.kinds": { disk: { cwd: work, prompt: "Сначала df -h.", notify: ["~yuri@example.com"] }, lost: { cwd: join(home, "нет-такой") }, far: { cwd: work, machines: ["server"] } } } });
    st.link.deliver({ type: "changed", what: "incidents.kinds" });
    const port = ((await st.request("incident.list", { to: "@laptop" })).result as any).port as number;
    await tick(20);
    const post = (x: object) => fetch(`http://127.0.0.1:${port}/incident`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(x) });
    const res = await post({ type: "disk", key: "c:", text: "место кончается", files: [{ name: "df.txt", mime: "text/plain", base64: Buffer.from("/ 99%").toString("base64") }] });
    expect(res.status).toBe(202);
    const proc = await until(() => st!.proc("disk-1@laptop"), 5000, "процесс инцидента");
    await until(() => proc.inputs.length === 1, 5000, "обращение во вводе");
    const content = proc.inputs[0]!.message.content as any[];
    expect(content[0]).toMatchObject({ type: "text", text: expect.stringContaining('<incident kind="disk" key="c:"') });
    expect(content[1]).toMatchObject({ type: "document", title: "df.txt", source: { data: "/ 99%" } });
    expect((st.sdk.last("disk-1@laptop")!.options as any).systemPrompt.append).toContain("Сначала df -h.");
    expect(st.services.of("reach.send")).toContainEqual(expect.objectContaining({ to: "~yuri@example.com", kind: "incident", title: expect.stringContaining("инцидент disk") }));
    expect(st.link.rows("disk-1@laptop").at(-1)!.row).toMatchObject({ incident: { kind: "disk", key: "c:" } });
    // вид другой машины здесь не действует; вид с негодной папкой — обращение ждёт с причиной
    expect((await post({ kind: "far", text: "x" })).status).toBe(400);
    expect(await st.request("incident.raise", { to: "@laptop", kind: "lost", key: "", text: "x" }, "@laptop")).toMatchObject({ ok: false, error: "open_failed" });
    const list = ((await st.request("incident.list", { to: "@laptop" })).result as any).incidents as any[];
    expect(list.find((a) => a.kind === "lost")).toMatchObject({ state: "pending", why: expect.stringContaining("bad_dir") });
    expect(list.find((a) => a.kind === "disk")).toMatchObject({ files: ["df.txt"], callsign: "disk-1@laptop" });
    expect(list.find((a) => a.kind === "disk").why).toBeUndefined();
  });

  it("подмена Host: обращение, уже отданное во ввод живого процесса, второй раз не шлётся", async () => {
    const home = mkdtempSync(join(tmpdir(), "sb2-host-"));
    const work = join(home, "work");
    mkdirSync(work, { recursive: true });
    const holders = new FakeHolders();
    const config = { "host-incidents": { kinds: { disk: { cwd: work } } } };
    const first = await stand({ home, holders, modules: [chat(), incidents()], config });
    expect((await first.request("incident.raise", { to: "@laptop", kind: "disk", key: "c:", text: "место" }, "@laptop")).ok).toBe(true);
    const proc = await until(() => first.proc("disk-1@laptop"), 5000, "процесс инцидента");
    await until(() => proc.inputs.length === 1, 5000, "обращение во вводе");
    await first.kernel.shutdown("подмена");
    st = await stand({ home, holders, modules: [chat(), incidents()], config });
    await until(() => st!.kernel.sessions.get("disk-1@laptop")?.state === "idle", 5000, "attach");
    await tick(40);
    expect(st.proc("disk-1@laptop")).toBe(proc);
    expect(proc.inputs).toHaveLength(1);
  });
});

describe("machine, proxy, profiles, remote", () => {
  it("журнал машины: вид строки, сессия и время", async () => {
    st = await stand({ modules: [machine(), chat()] });
    await st.open("site");
    await st.request("session.stop", { to: "ghost@laptop" });
    await st.request("message", { to: CS, text: "привет" });
    const refused = ((await st.request("machine.journal", { to: "@laptop", kind: "refuse" })).result as any).lines as any[];
    expect(refused.length).toBeGreaterThan(0);
    expect(refused.every((l) => l.msg === "request" && l.ok === false)).toBe(true);
    const about = ((await st.request("machine.journal", { to: "@laptop", session: CS })).result as any).lines as any[];
    expect(about.length).toBeGreaterThan(0);
    expect(about.every((l) => l.callsign === CS || l.to === CS)).toBe(true);
    expect(((await st.request("machine.journal", { to: "@laptop", since: 8e15 })).result as any).lines).toEqual([]);
  });

  it("правила прокси проверяются на тексте движком Host: текст после правил, срабатывания, ошибки правил; без rules — правила флота", async () => {
    st = await stand({ modules: [proxy()] });
    const domain = { name: "домен", scopes: ["user"], kind: "literal", unit: "match", action: "replace", pattern: "internal.example", replacement: "example" };
    const broken = { name: "плохое", scopes: ["user"], kind: "regex", unit: "match", action: "delete", pattern: "(" };
    const r = (await st.request("rules.test", { to: "@laptop", text: "пиши на internal.example и foo", rules: [domain, broken] })).result as any;
    expect(r.after).toBe("пиши на example и foo");
    expect(r.hits).toEqual({ домен: 1 });
    expect(Object.keys(r.flaws)).toEqual(["плохое"]);
    st.services.handlers["prefs.get"] = () => ({ values: { "proxy.rules": [{ ...domain, replacement: "fleet" }] } });
    const fleet = (await st.request("rules.test", { to: "@laptop", text: "internal.example", scope: "user" })).result as any;
    expect(fleet.after).toBe("fleet");
    // правило прежней формы страницы — без scopes и kind — движок называет негодным: форма одна
    expect(await st.request("rules.test", { to: "@laptop", text: "x", rules: [{ name: "старое", match: "a", replace: "b" }] })).toMatchObject({ ok: true, result: { flaws: { старое: expect.any(String) } } });
  });

  it("профили: «свести сейчас» отдаёт состояние клонов; ключа репозиториев нет — отказ; просмотр набора несёт настройки с проигравшими и файлы", async () => {
    const home = mkdtempSync(join(tmpdir(), "sb2-host-"));
    for (const [name, style] of [["base", "kit:short"], ["web", "kit:long"]] as const) {
      const piece = join(home, "profiles", "team__kit", name);
      mkdirSync(join(piece, "skills", "deploy"), { recursive: true });
      writeFileSync(join(piece, "skills", "deploy", "SKILL.md"), "---\nname: deploy\ndescription: выкладка\n---\nтекст");
      writeFileSync(join(piece, "settings.json"), JSON.stringify({ outputStyle: style }));
      writeFileSync(join(piece, "notes.txt"), "файл, который Claude не подключит");
    }
    st = await stand({ home, modules: [profiles({ git: async () => ({ code: 0, out: "" }) })] });
    st.services.handlers["prefs.get"] = () => ({ values: {} });
    expect(await st.request("profile.sync", { to: "@laptop" })).toMatchObject({ ok: false, error: "no_repos" });
    st.services.handlers["prefs.get"] = () => ({ values: { "profiles.repos": ["team/kit"] } });
    st.services.handlers["github.token"] = () => ({ token: "t", expires: 1 });
    const synced = (await st.request("profile.sync", { to: "@laptop" })).result as any;
    expect(synced.repos).toMatchObject([{ repo: "team/kit", state: "ok" }]);
    expect(((await st.request("profile.list", { to: "@laptop" })).result as any).repos).toMatchObject([{ repo: "team/kit", state: "ok" }]);
    const view = (await st.request("profile.view", { to: "@laptop", pieces: ["team/kit/base", "team/kit/web"] })).result as any;
    expect(view.settings.outputStyle).toMatchObject({ value: "kit:long", from: "team/kit/web", lost: [{ value: "kit:short", from: "team/kit/base" }] });
    expect(Object.keys(view.files)).toEqual(["team/kit/base", "team/kit/web"]);
    expect(view.other).toContainEqual({ from: "team/kit/base", path: "notes.txt" });
    expect(view.prompt.style).toMatchObject({ name: "kit:long" });
  });

  it("сведение принесло чужие правки кусочков — сессии этого репозитория перечитывают скилы; пустое сведение и чужой репозиторий сессию не трогают", async () => {
    const home = mkdtempSync(join(tmpdir(), "sb2-host-"));
    for (const repo of ["team__kit", "team__other"]) {
      mkdirSync(join(home, "profiles", repo, "base", ".git"), { recursive: true });
      mkdirSync(join(home, "profiles", repo, ".git"), { recursive: true });
      writeFileSync(join(home, "profiles", repo, "base", "CLAUDE.md"), "основа");
    }
    // поддельный git: голова клона kit меняется на втором сведении — как после чужого коммита
    let head = "a", pulls = 0;
    const git = async (args: string[], o: { cwd: string }) => {
      if (args.includes("pull") && o.cwd.endsWith("team__kit") && ++pulls === 2) head = "b";
      return { code: 0, out: args.includes("rev-parse") ? (o.cwd.endsWith("team__kit") ? head : "x") : "" };
    };
    st = await stand({ home, modules: [profiles({ git })] });
    st.services.handlers["prefs.get"] = () => ({ values: { "profiles.repos": ["team/kit", "team/other"] } });
    st.services.handlers["github.token"] = () => ({ token: "t", expires: 1 });
    await st.request("session.open", { to: "@laptop", spec: { name: "site", cwd: st.dir, pieces: ["team/kit/base"] } });
    await st.request("session.open", { to: "@laptop", spec: { name: "far", cwd: st.dir, pieces: ["team/other/base"] } });
    // у поддельного SDK перечитывания нет: считаем вызовы сами
    const seen: Record<string, number> = { "site@laptop": 0, "far@laptop": 0 };
    for (const cs of Object.keys(seen)) (st.sdk.last(cs) as any).reloadPlugins = async () => (seen[cs]!++, {});
    const reloads = (cs: string) => seen[cs]!;
    await st.request("profile.sync", { to: "@laptop" });
    await new Promise((r) => setTimeout(r, 20));
    expect([reloads("site@laptop"), reloads("far@laptop")]).toEqual([0, 0]);
    await st.request("profile.sync", { to: "@laptop" });
    await new Promise((r) => setTimeout(r, 20));
    expect([reloads("site@laptop"), reloads("far@laptop")]).toEqual([1, 0]);
  });

  it("Remote Control не включился — причина в строке сессии", async () => {
    st = await stand({ modules: [remote()] });
    await st.open("site");
    (st.sdk.last(CS) as any).enableRemoteControl = async () => {
      throw new Error("нет подписки");
    };
    expect((await st.request("session.update", { to: CS, patch: { remote: true } })).ok).toBe(true);
    await until(() => (st!.link.rows(CS).at(-1)!.row as any).remoteError === "нет подписки", 5000, "ошибка моста в строке");
  });
});
