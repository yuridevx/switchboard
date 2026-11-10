import { accountList, analyticsQuery, answer, buildsDeploy, buildsList, contract, createApi, type Frame, incidentList, invite, keeperState, keysList, ledgerRead, machineDirs, machineJournal, message, obsRecent, obsStats, passes, peopleList, peopleSet, pointsHistory, pointsList, pointsRaise, prefsGet, prefsSet, profileList, profileView, reachDevices, revoke, sessionCall, sessionHistory, sessionOpen, sessionUpdate, sessionWatch, whoami } from "@sb/protocol";
import { describe, expect, it } from "vitest";
import { fold } from "./chat/fold.ts";
import { nPoints, nTools, nTurns } from "./lib/time.ts";
import { toolLook } from "./chat/tools.ts";
import { researchTurn, siteTurn } from "./mock/convo.ts";
import { createMock } from "./mock/fleet.ts";
import { mergeEvents } from "./session/talk.ts";
import { applyFrame, emptyPicture, isMine, waitsYou, type Picture } from "./store/fleet.ts";

const T = 1_800_000_000_000;
const quiet = () => createMock({ now: () => T, live: false, latency: 0 });

describe("свёртка разговора", () => {
  it("ход: сообщение человека, ответ с инструментами, итог хода; список дел — последний", () => {
    const v = fold(siteTurn(T, "Почини шапку"));
    expect(v.rows[0]).toMatchObject({ k: "me", text: "Почини шапку" });
    expect(v.rows.at(-1)).toMatchObject({ k: "res" });
    expect(v.rows.filter((r) => r.k === "reply").length).toBeGreaterThan(3);
    expect(v.todos?.every((t) => t.status === "completed")).toBe(true);
    const edit = Object.values(v.tools).find((t) => t.name === "Edit")!;
    expect(toolLook(edit)).toMatchObject({ word: "Правка", sum: "src/components/Header.tsx", body: "diff" });
    expect(edit.result?.error).toBe(false);
  });
  it("шаги субагента лежат в его карточке, а не в ленте", () => {
    const v = fold(researchTurn(T, "Разберись"));
    const task = Object.values(v.tools).find((t) => t.name === "Task")!;
    expect(task.steps.length).toBe(2);
    expect(task.result?.text).toMatch(/три файла/);
    expect(v.rows.filter((r) => r.k === "me").length).toBe(1);
  });
  it("сообщение от другой сессии — строка с отправителем", () => {
    const v = fold([{ type: "user", uuid: "u1", message: { role: "user", content: '<fleet-message from="lead@laptop">\nНайди вызовы\n</fleet-message>' } }]);
    expect(v.rows[0]).toMatchObject({ k: "in", from: "lead@laptop", text: "Найди вызовы" });
  });
  it("история итогов хода не хранит: новый ввод после ответа закрывает прошлый ход строкой «ход закончен»", () => {
    const say = (uuid: string, text: string, extra = {}) => ({ type: "user", uuid, message: { role: "user", content: text }, ...extra });
    const reply = (uuid: string, text: string) => ({ type: "assistant", uuid, message: { id: "m" + uuid, content: [{ type: "text", text }] } });
    const v = fold([say("1", "Первый вопрос"), reply("2", "Первый ответ"), say("3", "Второй вопрос"), reply("4", "Второй ответ"), { type: "result", uuid: "5", duration_ms: 2000 }]);
    expect(v.rows.map((r) => r.k)).toEqual(["me", "reply", "res", "me", "reply", "res"]);
    expect(v.rows[2]).toMatchObject({ k: "res", bits: ["ход закончен"] });
    // после прерывания и после настоящего итога вторая строка не добавляется
    const w = fold([say("1", "Вопрос"), reply("2", "Ответ"), { type: "result", uuid: "3" }, say("4", "Ещё")]);
    expect(w.rows.filter((r) => r.k === "res").length).toBe(1);
  });
  it("своё сообщение видно сразу; в очереди — помечено и прошлый ход не закрывает; запись ленты с тем же текстом заменяет его", () => {
    const local = (uuid: string, text: string, queued: boolean) => ({ type: "user", uuid, message: { role: "user", content: text }, _local: true, ...(queued ? { _queued: true } : {}) });
    const reply = (uuid: string, text: string) => ({ type: "assistant", uuid, message: { id: "m" + uuid, content: [{ type: "text", text }] } });
    const base = [{ type: "user", uuid: "1", message: { role: "user", content: "Начни" } }, reply("2", "Работаю"), local("local-1", "И подвал", true)];
    const v = fold(base);
    expect(v.rows.map((r) => r.k)).toEqual(["me", "reply", "me"]);
    expect(v.rows[2]).toMatchObject({ k: "me", text: "И подвал", state: "queued", uuid: "local-1" });
    // ход кончился — сообщение ушло сессии
    expect(fold([...base, { type: "result", uuid: "3" }]).rows[2]).toMatchObject({ state: "sent" });
    // лента прислала это сообщение — показанное заранее убрано, повтора нет
    const merged = mergeEvents(base, [{ type: "user", uuid: "9", message: { role: "user", content: "И подвал" } }]);
    expect(merged.map((e) => e.uuid)).toEqual(["1", "2", "9"]);
    // отправленное не в очередь — обычный пузырь, прошлый ход закрыт
    expect(fold([base[0], base[1], local("local-2", "Дальше", false)]).rows.map((r) => r.k)).toEqual(["me", "reply", "res", "me"]);
  });
  it("числительные склоняются одной функцией", () => {
    expect([1, 2, 4, 5, 11, 21, 24, 112].map(nPoints)).toEqual(["1 точка", "2 точки", "4 точки", "5 точек", "11 точек", "21 точка", "24 точки", "112 точек"]);
    expect(nTurns(2)).toBe("2 хода");
    expect(nTools(24)).toBe("24 инструмента");
  });
  it("история и живое сливаются по uuid без повторов", () => {
    const a = [{ type: "user", uuid: "1" }, { type: "assistant", uuid: "2" }];
    expect(mergeEvents(a, [{ type: "assistant", uuid: "2" }, { type: "result", uuid: "3" }]).map((e) => e.uuid)).toEqual(["1", "2", "3"]);
    expect(mergeEvents(a, [{ type: "assistant", uuid: "2" }])).toBe(a);
  });
});

describe("картина флота", () => {
  const snap = (): Picture => {
    const m = quiet();
    let got: Frame | null = null;
    m.transport.open("page", { onFrame: (f) => (got ??= f) });
    return new Promise<Picture>((res) => setTimeout(() => res(applyFrame(emptyPicture, got!)), 60)) as never;
  };
  it("снимок заменяет картину; изменение правит строку; null убирает сессию", async () => {
    const p = await snap();
    expect(Object.keys(p.machines)).toEqual(["laptop", "server", "anya-pc", "base2"]);
    const next = applyFrame(p, { type: "roster.delta", rev: p.rev + 1, sessions: [{ callsign: "site@laptop", row: { ...p.sessions["site@laptop"]!, state: "idle" } }, { callsign: "docs@laptop", row: null }] });
    expect(next.sessions["site@laptop"]).toMatchObject({ state: "idle", title: "Шапка сайта на узких экранах" });
    expect(next.sessions["docs@laptop"]).toBeUndefined();
    expect(next.rev).toBe(p.rev + 1);
  });
  it("лампа «ждут вас»: горит, пока есть вопрос или непрочитанное; без них гаснет", async () => {
    const p = await snap();
    expect(waitsYou(p)).toBe(true);
    const calm = Object.fromEntries(Object.entries(p.sessions).map(([k, s]) => [k, { ...s, ask: null, unread: [] }]));
    expect(waitsYou({ ...p, sessions: calm as never })).toBe(false);
  });
  it("моя сессия: открыл я или сессия, которую открыл я", async () => {
    const p = await snap();
    expect(isMine(p, p.sessions["wing@laptop"])).toBe(true);
    expect(isMine(p, p.sessions["landing@anya-pc"])).toBe(false);
  });
});

describe("мок флота", () => {
  it("каждый запрос страницы отвечен; неизвестный — отказ unknown_request", async () => {
    const m = quiet();
    const api = createApi(m.transport);
    const calls: Array<() => Promise<unknown>> = [
      () => api.call(whoami, {}), () => api.call(peopleList, {}), () => api.call(passes, {}), () => api.call(sessionHistory, { to: "site@laptop" }), () => api.call(sessionWatch, { to: "site@laptop" }),
      () => api.call(sessionCall, { to: "site@laptop", method: "contextUsage" }), () => api.call(accountList, { to: "@laptop" }), () => api.call(profileList, { to: "@laptop" }), () => api.call(profileView, { to: "@laptop", pieces: ["base", "web"] }),
      () => api.call(machineDirs, { to: "@laptop" }), () => api.call(machineJournal, { to: "@server" }), () => api.call(keeperState, { to: ".keeper@server" }), () => api.call(incidentList, { to: "@server" }),
      () => api.call(buildsList, {}), () => api.call(ledgerRead, {}), () => api.call(pointsList, {}), () => api.call(pointsHistory, { sid: m.state.archive[0].sid }), () => api.call(reachDevices, {}), () => api.call(prefsGet, { scope: "me" }),
      () => api.call(keysList, {}), () => api.call(analyticsQuery, { by: "model", since: "2026-11-01", until: "2026-11-07" }), () => api.call(obsRecent, {}), () => api.call(obsStats, { since: T - 7_200_000, until: T }),
    ];
    for (const c of calls) await expect(c()).resolves.toBeDefined();
    const r = await m.transport.call({ type: "nope.nope", id: "1" });
    expect(r).toMatchObject({ ok: false, error: "unknown_request" });
    for (const f of ["session.open", "message", "answer", "points.list", "obs.recent"]) expect(contract.request(f)).toBeDefined();
  });
  it("ответ на вопрос снимает его и сессия работает дальше; второй ответ — already_answered", async () => {
    const m = quiet();
    const api = createApi(m.transport);
    const ask = m.state.sessions["site-tests@laptop"].ask!;
    await api.call(answer, { to: "site-tests@laptop", ask: ask.id, answer: "main" });
    expect(m.state.sessions["site-tests@laptop"]).toMatchObject({ state: "busy", ask: null });
    await expect(api.call(answer, { to: "site-tests@laptop", ask: ask.id, answer: "main" })).rejects.toMatchObject({ word: "already_answered" });
  });
  it("занятая сессия пишет события зрителю и заканчивает ход с итогом и пометкой «непрочитано»", async () => {
    const m = quiet();
    const api = createApi(m.transport);
    const seen: Frame[] = [];
    m.transport.open("watch", { machine: "server", onFrame: (f) => seen.push(f) });
    await api.call(sessionWatch, { to: "ingest@server" });
    for (let i = 0; i < 8; i++) m.tick();
    // семь шагов хода и подсказка следующего сообщения после его конца
    expect(seen.length).toBe(8);
    expect(seen.every((f) => f.type === "session.events" && f.callsign === "ingest@server")).toBe(true);
    expect(m.state.sessions["ingest@server"]).toMatchObject({ state: "idle" });
    expect(m.state.sessions["ingest@server"].result).toMatch(/предел 10 секунд/);
    expect(m.state.sessions["site@laptop"].unread).toEqual(["~yuri@example.com"]);
  });
  it("сообщение свободной сессии запускает ход; занятой — встаёт в очередь; машине без связи — offline", async () => {
    const m = quiet();
    const api = createApi(m.transport);
    await expect(api.call(message, { to: "nightcheck@server", text: "Проверь ещё раз" })).resolves.toMatchObject({ queued: false });
    expect(m.state.sessions["nightcheck@server"].state).toBe("busy");
    // занятая сессия: сообщение ждёт конца хода и до этого в разговор не попадает; из очереди его можно снять
    const before = (await api.call(sessionHistory, { to: "site@laptop" })).events.length;
    const q = (await api.call(message, { to: "site@laptop", text: "И подвал" })) as { queued?: boolean; uuid?: string };
    expect(q).toMatchObject({ queued: true });
    expect((await api.call(sessionHistory, { to: "site@laptop" })).events.length).toBe(before);
    await expect(api.call(sessionCall, { to: "site@laptop", method: "cancelMessage", args: { uuid: q.uuid } })).resolves.toEqual({ cancelled: true });
    // второй раз снимать нечего
    await expect(api.call(sessionCall, { to: "site@laptop", method: "cancelMessage", args: { uuid: q.uuid } })).resolves.toEqual({ cancelled: false });
    await expect(api.call(message, { to: "crawler@base2", text: "Как дела?" })).rejects.toMatchObject({ word: "offline" });
  });
  it("ответ мока — копия: следующая запись его не меняет", async () => {
    const m = quiet();
    const api = createApi(m.transport);
    const was = await api.call(peopleList, {});
    await api.call(peopleSet, { person: "~anya@example.com", projects: ["site", "infra"] });
    const now = await api.call(peopleList, {});
    expect(was.people.find((p) => p.person === "~anya@example.com")!.projects).toEqual(["site"]);
    expect(now.people.find((p) => p.person === "~anya@example.com")!.projects).toEqual(["site", "infra"]);
  });
  it("записи видны сразу: документ сессии, проект человека, настройка заплаткой, приглашение и отзыв, сборка", async () => {
    const m = quiet();
    const api = createApi(m.transport);
    await api.call(sessionUpdate, { to: "site@laptop", patch: { model: "claude-sonnet-5-5" } });
    expect(m.state.sessions["site@laptop"].spec.model).toBe("claude-sonnet-5-5");
    await api.call(peopleSet, { person: "~oleg@example.com", projects: ["infra", "site"] });
    expect((await api.call(peopleList, {})).projects.find((p) => p.id === "site")!.members).toContain("~oleg@example.com");
    await api.call(prefsSet, { scope: "fleet", name: "labels", patch: { "docs@laptop": "Документация", "site@laptop": null } });
    expect((await api.call(prefsGet, { scope: "fleet", prefix: "labels" })).values.labels).toEqual({ "docs@laptop": "Документация" });
    const inv = await api.call(invite, { addr: "tablet~yuri@example.com" });
    expect((await api.call(passes, {})).passes[0]).toMatchObject({ kid: inv.kid, wait: true });
    await api.call(revoke, { kid: inv.kid });
    expect((await api.call(passes, {})).passes.some((p) => p.kid === inv.kid)).toBe(false);
    await api.call(buildsDeploy, { build: 411 });
    expect((await api.call(buildsList, {})).stable).toBe(411);
  });
  it("новая сессия появляется в картине; поднятая из архива — на другой машине с тем же разговором", async () => {
    const m = quiet();
    const api = createApi(m.transport);
    const deltas: Frame[] = [];
    m.transport.open("page", { onFrame: (f) => deltas.push(f) });
    await new Promise((r) => setTimeout(r, 60));
    const { callsign } = await api.call(sessionOpen, { to: "@server", spec: { name: "probe", cwd: "~/projects/infra" }, prompt: "Проверь диск" });
    expect(callsign).toBe("probe@server");
    expect(deltas.at(-1)).toMatchObject({ type: "roster.delta", sessions: [{ callsign: "probe@server" }] });
    await expect(api.call(sessionOpen, { to: "@server", spec: { name: "probe", cwd: "~/x" } })).rejects.toMatchObject({ word: "name_taken" });
    const found = await api.call(pointsList, { q: "шапка" });
    expect(found.sessions[0]).toMatchObject({ callsign: "site@laptop" });
    expect(found.sessions[0].hit).toMatch(/[Шш]апк/);
    const up = await api.call(pointsRaise, { to: "@server", sid: found.sessions[0].sid });
    expect(up.callsign).toBe("site@server");
    expect((await api.call(sessionHistory, { to: "site@server" })).events.length).toBeGreaterThan(5);
  });
  it("аналитика недоступна — отказ словом; остальное отвечает", async () => {
    const m = quiet();
    const api = createApi(m.transport);
    m.setAnalyticsDown(true);
    await expect(api.call(analyticsQuery, { by: "day", since: "2026-11-01", until: "2026-11-07" })).rejects.toMatchObject({ word: "analytics_unavailable" });
    await expect(api.call(pointsList, {})).resolves.toBeDefined();
  });
  it("каждый запрос оставляет строку наблюдения с отрезками пути и исходом", async () => {
    const m = quiet();
    const api = createApi(m.transport);
    await api.call(message, { to: "crawler@base2", text: "?" }).catch(() => {});
    const { rows } = await api.call(obsRecent, { failed: true, limit: 1 });
    expect(rows[0]).toMatchObject({ type: "message", to: "crawler@base2", ok: false, word: "offline" });
    expect(rows[0].spans!.map((s) => s.part)).toEqual(["services", "platform", "host"]);
  });
});
