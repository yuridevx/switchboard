// Свойства плана тестов v2, у которых не было теста: отказы словом и ожидаемые ветки запросов сессии.
// Источник свойств — устав («система ловит»: отказ словом с причиной) и код (помечено «чьё: код»).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Module } from "../src/core/contract.ts";
import { make as chat } from "../src/modules/chat/chat.ts";
import { stand, type Stand } from "../stand/index.ts";

let st: Stand | undefined;
afterEach(async () => {
  await st?.stop();
  st = undefined;
});

const PULT = "pult~yuri@example.com";
const CS = "site@laptop";

describe("план v2: запросы сессии", () => {
  it("откат у остановленной сессии — отказ stopped, процесс не поднимается", async () => {
    st = await stand({ modules: [chat()] });
    await st.open("site");
    await st.request("session.stop", { to: CS }, PULT);
    const before = st.sdk.of(CS).length;
    expect(await st.request("session.rewind", { to: CS, upto: "h1" }, PULT)).toMatchObject({ ok: false, error: "stopped" });
    expect(st.sdk.of(CS)).toHaveLength(before);
  });

  it("метод SDK отказал — sdk_error с позывным и методом; сессия работает дальше", async () => {
    st = await stand({ modules: [chat()] });
    const { q } = await st.open("site");
    (q as any).getContextUsage = async () => {
      throw new Error("нет данных");
    };
    const r = await st.request("session.call", { to: CS, method: "contextUsage" }, PULT);
    expect(r).toMatchObject({ ok: false, error: "sdk_error" });
    expect(String((r as any).why)).toContain(CS);
    await st.turn(CS);
    expect(st.kernel.sessions.get(CS)!.state).toBe("idle");
  });

  // чьё: код — у сервера флота в настройках лежит пропуск машины
  it("список серверов MCP уходит без заголовков и окружения", async () => {
    st = await stand({ modules: [chat()] });
    const { q } = await st.open("site");
    (q as any).mcpServerStatus = async () => [{ name: "fleet", status: "connected", config: { type: "http", url: "https://x", headers: { authorization: "секрет" }, env: { TOKEN: "секрет" } } }];
    const r = await st.request("session.call", { to: CS, method: "mcpStatus" }, PULT);
    expect(JSON.stringify(r.result)).not.toContain("секрет");
    expect(r.result).toMatchObject([{ name: "fleet", status: "connected", config: { url: "https://x" } }]);
  });

  // чьё: код — перечитывание запущенные серверы не трогает, кроме серверов плагинов
  it("перечитывание: скилы и агенты с диска, затем переподключение только подключённых серверов плагинов", async () => {
    st = await stand({ modules: [chat()] });
    const { q } = await st.open("site");
    const seen: string[] = [];
    (q as any).reloadPlugins = async () => (seen.push("reload"), { mcpServers: [{ name: "plugin:x", status: "connected" }, { name: "plugin:y", status: "failed" }, { name: "fleet", status: "connected" }] });
    (q as any).reconnectMcpServer = async (name: string) => void seen.push("reconnect " + name);
    expect(await st.request("session.call", { to: CS, method: "reload" }, PULT)).toMatchObject({ ok: true });
    expect(seen).toEqual(["reload", "reconnect plugin:x"]);
  });

  it("session.read от сессии — отказ not_client: читает человек", async () => {
    st = await stand({ modules: [chat()] });
    await st.open("site");
    expect(await st.request("session.read", { to: CS }, "docs@server")).toMatchObject({ ok: false, error: "not_client" });
  });

  it("ведомого убрали отдельно — ведущая живёт без пары", async () => {
    st = await stand({ modules: [chat()] });
    await st.request("session.open", { to: "@laptop", spec: { name: "lead", cwd: st.dir }, pair: true }, PULT);
    expect(await st.request("session.remove", { to: "lead-wing@laptop" }, PULT)).toMatchObject({ ok: true });
    const lead = st.kernel.sessions.get("lead@laptop")!;
    expect(lead.rec.spec.wing).toBeUndefined();
    expect(lead.state).toBe("idle");
    expect(st.kernel.sessions.has("lead-wing@laptop")).toBe(false);
  });

  // чьё: код — подсказка файлов для «@» в поле ввода
  it("файлы папки сессии по слову: пути от папки со слешами «/», без учёта регистра", async () => {
    st = await stand({ modules: [chat()] });
    await st.open("site");
    mkdirSync(join(st.dir, "src", "Menu"), { recursive: true });
    writeFileSync(join(st.dir, "src", "Menu", "TopBar.tsx"), "x");
    writeFileSync(join(st.dir, "readme.md"), "x");
    const r = await st.request("session.files", { to: CS, q: "topbar" }, PULT);
    expect((r.result as { files: string[] }).files).toEqual(["src/Menu/TopBar.tsx"]);
  });

  // чьё: код — подъём точки идёт открытием сессии по её документу; ключ без хозяина на машине — отказ, а не молчаливая потеря
  it("документ точки со старым ключом account (до очередей) — отказ bad_spec, сессия не открыта", async () => {
    st = await stand({ modules: [chat()] });
    const open = st.kernel.open({ name: "old", cwd: st.dir, account: "a@example.com" } as never, { by: PULT });
    await expect(open).rejects.toMatchObject({ word: "bad_spec" });
    expect(st.kernel.sessions.has("old@laptop")).toBe(false);
  });
});

describe("план v2: ошибка модуля", () => {
  // чьё: код — модуль после ошибки работает дальше; устав говорит «модуль выключен» — расхождение вынесено пользователю в плане
  it("модуль бросил на событии — причина в журнале, соседний модуль событие получил, сессия работает", async () => {
    const got: string[] = [];
    const bad: Module = { name: "bad", on: { event: () => { throw new Error("сломан"); } } };
    const good: Module = { name: "good", on: { event: (_s, m) => void got.push(String(m.type)) } };
    st = await stand({ modules: [bad, good] });
    await st.open("site");
    await st.turn(CS, [{ type: "assistant", uuid: "a1", message: { role: "assistant", content: [{ type: "text", text: "ок" }] } }]);
    expect(got).toContain("assistant");
    expect(st.kernel.sessions.get(CS)!.state).toBe("idle");
    expect(st.journal().some((l) => l.level === "error" && JSON.stringify(l).includes("bad"))).toBe(true);
  });
});
