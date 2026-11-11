// Эталоны «Очереди по модели»: очередь диктует выбор модели и следит за лимитом своего вида.
// Источник свойств — слово пользователя 11 нояб. 2026: важны неделя и лимит Fable, очередь Fable отдельно от остальных, слот диктует выбор модели.
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { make as accounts } from "../src/modules/accounts/accounts.ts";
import { folders } from "../src/modules/accounts/links.ts";
import { stand, tick, until, type Stand } from "../stand/index.ts";

let st: Stand | undefined;
afterEach(async () => {
  await st?.stop();
  st = undefined;
});

const A = "a@example.com", B = "b@example.com";
const WEEK = "seven_day", FABLE = "seven_day_overage_included";
const sec = () => Math.floor(Date.now() / 1000);

function home(names: string[], limits: Record<string, unknown>, slots: Record<string, string[]>, models: Record<string, "fable" | "other"> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "sb2-host-"));
  mkdirSync(join(dir, "store"), { recursive: true });
  const book = { accounts: Object.fromEntries(names.map((n) => [n, { login: "ok", plan: "max", limits: limits[n] ?? {} }])), slots, models };
  writeFileSync(join(dir, "store", "host-accounts.json"), JSON.stringify({ machine: book }));
  const dirs = folders(dir);
  for (const n of names) mkdirSync(dirs.accDir(n), { recursive: true });
  for (const [slot, order] of Object.entries(slots)) symlinkSync(dirs.accDir(order[0]!), (mkdirSync(join(dir, "slots"), { recursive: true }), dirs.slotDir(slot)), process.platform === "win32" ? "junction" : "dir");
  return dir;
}
const envOf = (callsign: string) => (st!.sdk.last(callsign)!.options as any).env as Record<string, string>;
const slotsOf = async () => ((await st!.request("account.list", { to: "@laptop" })).result as any).slots as Array<{ name: string; model: string; account?: string; wait?: number }>;
const swaps = () => st!.services.of("ledger.add").filter((f) => f.what === "account.swapped").map((f) => String(f.text));

describe("очереди по модели", () => {
  it("1. очереди fable и остальных стоят на одном аккаунте, Fable дошёл до 98 %: fable идёт на следующего, остальные остаются", async () => {
    const reset = sec() + 86_400, at = sec();
    const lim = (week: number, fable: number) => ({ [WEEK]: { utilization: week, resetsAt: reset, at }, [FABLE]: { utilization: fable, resetsAt: reset, at } });
    const dir = home([A, B], { [A]: lim(0.2, 0.5), [B]: lim(0.1, 0.1) }, { main: [A, B], rest: [A, B] }, { rest: "other" });
    st = await stand({ home: dir, modules: [accounts()] });
    const one = await st.open("site", { slot: "main" });
    await st.open("docs", { slot: "rest" });
    one.proc.send({ type: "rate_limit_event", rate_limit_info: { status: "allowed_warning", rateLimitType: FABLE, utilization: 0.98, resetsAt: reset } });
    await until(() => folders(dir).inSlot("main") === B, 5000, "очередь fable ушла на следующего");
    await tick(30);
    expect(folders(dir).inSlot("rest")).toBe(A);
    expect(swaps().filter((t) => t.startsWith("очередь rest:"))).toHaveLength(0);
    expect(swaps().find((t) => t.startsWith("очередь main:"))).toMatch(/Fable 98 %/);
  });

  it("2. общая неделя аккаунта дошла до 98 %: аккаунт меняют очереди обоих видов", async () => {
    const reset = sec() + 86_400, at = sec();
    const lim = (week: number) => ({ [WEEK]: { utilization: week, resetsAt: reset, at } });
    const dir = home([A, B], { [A]: lim(0.5), [B]: lim(0.1) }, { main: [A, B], rest: [A, B] }, { rest: "other" });
    st = await stand({ home: dir, modules: [accounts()] });
    await st.open("site", { slot: "main" });
    const two = await st.open("docs", { slot: "rest" });
    two.proc.send({ type: "rate_limit_event", rate_limit_info: { status: "allowed_warning", rateLimitType: WEEK, utilization: 0.98, resetsAt: reset } });
    await until(() => folders(dir).inSlot("main") === B && folders(dir).inSlot("rest") === B, 5000, "смена в обеих очередях");
  });

  it("3. в очереди fable у всех аккаунтов Fable у порога, неделя свободна: очередь ждёт сброса, модель сессии остаётся Fable", async () => {
    const reset = sec() + 600, at = sec();
    const dir = home([A], { [A]: { [WEEK]: { utilization: 0.2, resetsAt: reset, at }, [FABLE]: { utilization: 0.99, resetsAt: reset, at } } }, { main: [A] });
    st = await stand({ home: dir, modules: [accounts()] });
    st.services.handlers["keys.list"] = () => ({ keys: [] });
    await st.open("site", { slot: "main" });
    expect((await slotsOf())[0]).toMatchObject({ name: "main", model: "fable", account: A, wait: reset * 1000 });
    expect(st.link.rows("site@laptop").at(-1)!.row).toMatchObject({ account: A, wait: reset * 1000 });
    expect(envOf("site@laptop").ANTHROPIC_MODEL).toBe("fable");
  });

  it("4. очередь диктует выбор модели: Fable в очереди остальных и Opus в очереди fable — отказ model_not_in_slot, документ не меняется; вид очереди с такой сессией не сменить", async () => {
    const dir = home([A], {}, { main: [A], rest: [A] }, { rest: "other" });
    st = await stand({ home: dir, modules: [accounts()] });
    expect(await st.request("session.open", { to: "@laptop", spec: { name: "x", cwd: st.dir, slot: "rest", model: "claude-fable-5-2" } })).toMatchObject({ ok: false, error: "model_not_in_slot" });
    expect(await st.request("session.open", { to: "@laptop", spec: { name: "y", cwd: st.dir, slot: "main", model: "claude-opus-5-5" } })).toMatchObject({ ok: false, error: "model_not_in_slot" });
    const { s } = await st.open("docs", { slot: "rest", model: "claude-sonnet-5-5" });
    expect(await st.request("session.update", { to: "docs@laptop", patch: { model: "claude-fable-5-2" } })).toMatchObject({ ok: false, error: "model_not_in_slot" });
    expect(await st.request("session.update", { to: "docs@laptop", patch: { slot: "main" } })).toMatchObject({ ok: false, error: "model_not_in_slot" });
    expect(s.rec.spec).toMatchObject({ slot: "rest", model: "claude-sonnet-5-5" });
    expect(await st.request("slot.set", { to: "@laptop", slot: "rest", model: "fable", order: [A] })).toMatchObject({ ok: false, error: "has_sessions", why: expect.stringMatching(/docs@laptop/) });
    // прочие ключи документа правятся и у сессии, чья модель очереди уже не подходит
    st.kernel.disk.section<any>("host-accounts").update((b: any) => ({ ...b, models: { ...b.models, rest: "fable" } }));
    expect((await st.request("session.update", { to: "docs@laptop", patch: { effort: "low" } })).ok).toBe(true);
    expect(await st.request("session.update", { to: "docs@laptop", patch: { model: "claude-haiku-5-5" } })).toMatchObject({ ok: false, error: "model_not_in_slot" });
    st.kernel.disk.section<any>("host-accounts").update((b: any) => ({ ...b, models: { ...b.models, rest: "other" } }));
    // очередь и модель одним запросом — можно
    expect((await st.request("session.update", { to: "docs@laptop", patch: { slot: "main", model: "claude-fable-5-2" } })).ok).toBe(true);
  });

  it("5. постороннее окно на 100 % и отказ по окну, за которым очередь не следит: аккаунт не меняется", async () => {
    const reset = sec() + 600, at = sec();
    const dir = home([A, B], { [A]: { iguana_necktie: { utilization: 1, resetsAt: reset, at }, [FABLE]: { utilization: 1, resetsAt: reset, at } } }, { rest: [A, B] }, { rest: "other" });
    st = await stand({ home: dir, modules: [accounts()] });
    st.services.handlers["keys.list"] = () => ({ keys: [] });
    const { proc } = await st.open("docs", { slot: "rest" });
    expect((await slotsOf())[0]!.wait).toBeUndefined();
    proc.send({ type: "system", subtype: "session_state_changed", state: "running" });
    proc.send({ type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "overage", resetsAt: reset } });
    proc.send({ type: "assistant", error: "rate_limit", message: { content: [] } });
    proc.send({ type: "result", subtype: "success", result: "" });
    proc.send({ type: "system", subtype: "session_state_changed", state: "idle" });
    await tick(50);
    expect(folders(dir).inSlot("rest")).toBe(A);
    expect(swaps()).toHaveLength(0);
    expect(proc.inputs.some((i) => i.message.content === "Продолжай")).toBe(false);
  });

  it("6. сессия без своей модели: в очереди остальных стартует на Opus, в очереди fable — на Fable; своя модель идёт как задана", async () => {
    const dir = home([A], {}, { main: [A], rest: [A] }, { rest: "other" });
    st = await stand({ home: dir, modules: [accounts()] });
    await st.open("site", { slot: "main" });
    await st.open("docs", { slot: "rest" });
    await st.open("fast", { slot: "rest", model: "claude-haiku-5-5" });
    expect(envOf("site@laptop").ANTHROPIC_MODEL).toBe("fable");
    expect(envOf("docs@laptop").ANTHROPIC_MODEL).toBe("opus");
    expect(envOf("fast@laptop").ANTHROPIC_MODEL).toBeUndefined();
    expect((st.sdk.last("fast@laptop")!.options as any).model).toBe("claude-haiku-5-5");
  });

  it("7. очередь fable переключили на остальные: её сессия без своей модели стартует заново на Opus; очередь отдаёт новый вид", async () => {
    const dir = home([A], {}, { main: [A] });
    st = await stand({ home: dir, modules: [accounts()] });
    st.services.handlers["keys.list"] = () => ({ keys: [] });
    await st.open("site", { slot: "main" });
    expect((await st.request("slot.set", { to: "@laptop", slot: "main", model: "other", order: [A] })).ok).toBe(true);
    await until(() => st!.sdk.of("site@laptop").length === 2 && envOf("site@laptop").ANTHROPIC_MODEL === "opus", 5000, "перезапуск на модели очереди");
    expect((await slotsOf())[0]).toMatchObject({ name: "main", model: "other" });
    // порядок без вида вид не меняет
    expect((await st.request("slot.set", { to: "@laptop", slot: "main", order: [A] })).ok).toBe(true);
    expect((await slotsOf())[0]!.model).toBe("other");
  });
});
