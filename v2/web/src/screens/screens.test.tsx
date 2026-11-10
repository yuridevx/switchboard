/// <reference types="node" />
// Экраны страницы, кроме разговора: чистые правила экранов, запросы мока в формах договора, сервис-воркер, несколько экранов в отрисовке.
import fs from "node:fs";
import path from "node:path";
import {
  accountList, consent, createApi, fleetList, invite, keysRemove, ledgerRead, obsHealth, obsRecent, obsReport, passes, peopleList, pointsCalls, pointsDelete, pointsHistory, pointsList,
  pointsRaise, profileList, profileSync, profileView, ProxyRule, reachBot, reachSubscribe, rulesTest, sessionStop, slotSet, slotSwap, type Account, type ArchSession, type SessionRow,
} from "@sb/protocol";
import { MantineProvider } from "@mantine/core";
import { Steps } from "../shell/Page.tsx";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as apiModule from "../api.ts";
import { limitTone, limitWord, mergeAccounts, otherMail, queueMove, seatOptions } from "../lib/accounts.ts";
import { getLocal, setLocal } from "../lib/local.ts";
import { deviceLabel, keyBytes, pushStateOf, subscriptionFields } from "../lib/push.ts";
import { byDay, dayWord } from "../lib/time.ts";
import { SAY, sayWord } from "../lib/words.ts";
import { BUILTIN, dropTarget, groupsOf, matches, projectOf, reorder, rowsOf, shift } from "../lib/work.ts";
import { applyRules } from "../mock/screens.ts";
import { createMock, type Mock } from "../mock/fleet.ts";
import { backUrl, consentOf } from "../shell/Consent.tsx";
import { gateOf, stopOf } from "../shell/Gate.tsx";
import { openFromQuery } from "../shell/open.ts";
import { offlineLine } from "../shell/Shell.tsx";
import { applyFrame, emptyPicture, useFleet, type Picture } from "../store/fleet.ts";
import { cutByPoints, pullCommand, sinceOf } from "./Archive.tsx";
import { fireList, fireRun } from "./archive/Fire.tsx";
import { checkWord, DeleteTyped, raiseInput, stepsOf } from "./archive/Raise.tsx";
import { keyInput, parsePairs, pairsText } from "./fleet/Accounts.tsx";
import { splitIncidents } from "./fleet/Incidents.tsx";
import { installCommand } from "./fleet/Machines.tsx";
import { pieceMatches, summary, VIEW_TABS } from "./fleet/Profiles.tsx";
import { rollState } from "./fleet/Releases.tsx";
import { ledgerMatches, mergeLedger } from "./Observe.tsx";
import { myPushDevices } from "./settings/Alerts.tsx";
import { pricesOfRows, rowsOfPrices } from "./settings/Fleetwide.tsx";
import { InviteLink, linkOf, qrSvg } from "./settings/Invite.tsx";
import { byWord } from "./settings/Passes.tsx";
import { reachOf } from "./settings/People.tsx";
import { newRule, ruleFlaw, ruleLine } from "./settings/Proxy.tsx";
import { githubReturn } from "./settings/Rest.tsx";
import { worker } from "./sw-harness.ts";
import { Work } from "./Work.tsx";

vi.hoisted(() => {
  (globalThis as any).window?.happyDOM?.setURL("http://localhost/?still");
  if (!(document as any).fonts) Object.defineProperty(document, "fonts", { value: { addEventListener() {}, removeEventListener() {} } });
});

const T = 1_800_000_000_000;
const quiet = () => createMock({ now: () => T, live: false, latency: 0 });
const snap = async (m = quiet()): Promise<Picture> => new Promise((res) => {
  const l = m.transport.open("page", { onFrame: (f) => (l.close(), res(applyFrame(emptyPicture, f))) });
});
const ask = (m: Mock) => createApi(m.transport);

describe("слова отказов", () => {
  it("каждое слово, которое умеет сказать часть флота, есть в словаре страницы", () => {
    const root = path.resolve(process.cwd(), "..");
    const found = new Set<string>();
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name)) for (const m of fs.readFileSync(p, "utf8").matchAll(/(?:Refusal|refuse|refused)\("([a-z_]+)"|fail\([^,()]+, "([a-z_]+)"|shut\([a-z]+, "([a-z_]+)"/g)) found.add(m[1] ?? m[2] ?? m[3]!);
      }
    };
    for (const part of ["host/src", "services/src", "platform/src", "protocol/src"]) walk(path.join(root, part));
    expect(found.size).toBeGreaterThan(40);
    expect([...found].filter((w) => !SAY[w])).toEqual([]);
    expect(sayWord("offline")).toBe("Машина не на связи");
    expect(sayWord("такого_нет")).toBe("такого_нет");
  });
});

describe("уведомления", () => {
  const env = { ua: "Mozilla/5.0 (Windows NT 10.0) Chrome/140", standalone: false, hasSw: true, hasPush: true, permission: "default" as NotificationPermission, subscribed: false };
  it("состояние: iPhone вне «Домой» — установка; нет поддержки; отказ; выключено; включено", () => {
    expect(pushStateOf({ ...env, ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 19_0) Safari/605" })).toBe("install");
    expect(pushStateOf({ ...env, ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 19_0) Safari/605", standalone: true })).toBe("off");
    expect(pushStateOf({ ...env, hasPush: false })).toBe("unsupported");
    expect(pushStateOf({ ...env, permission: "denied" })).toBe("denied");
    expect(pushStateOf({ ...env, permission: "granted" })).toBe("off");
    expect(pushStateOf({ ...env, permission: "granted", subscribed: true })).toBe("on");
  });
  it("ключ флота — байтами; поля подписки — base64url без хвоста; устройство названо по браузеру", () => {
    expect([...keyBytes("AQID-_8")]).toEqual([1, 2, 3, 251, 255]);
    const sub = { endpoint: "https://push.example/abc", getKey: (n: string) => new Uint8Array(n === "auth" ? [255, 254, 253] : [1, 2, 3, 4]).buffer };
    expect(subscriptionFields(sub)).toEqual({ endpoint: "https://push.example/abc", p256dh: "AQIDBA", auth: "__79" });
    expect(deviceLabel("Mozilla/5.0 (Linux; Android 15) Chrome/140")).toBe("Android, Chrome");
  });
  it("мок принимает только настоящую подписку браузера: заглушка отвергнута", async () => {
    const api = ask(quiet());
    await expect(api.call(reachSubscribe, { kind: "webpush", endpoint: "push.example", p256dh: "-", auth: "-" })).rejects.toMatchObject({ word: "bad_input" });
    await expect(api.call(reachSubscribe, { kind: "webpush", endpoint: "https://fcm.googleapis.com/fcm/send/x", p256dh: "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-Skv", auth: "tBHItJI5svbpez7KI4CCXg" })).resolves.toMatchObject({ id: expect.any(String) });
  });
  it("подписки этого устройства — те, что записаны его пропуском", () => {
    const d = (id: string, kind: "webpush" | "telegram", kid?: string) => ({ id, kind, person: "~a@b.c", at: 0, ...(kid ? { kid } : {}) });
    expect(myPushDevices([d("1", "webpush", "k1"), d("2", "webpush", "k2"), d("3", "telegram", "k1")], "k1").map((x) => x.id)).toEqual(["1"]);
    expect(myPushDevices([d("1", "webpush")], "")).toEqual([]);
  });

  const note = { title: "site@laptop спрашивает", text: "Какую ветку?", callsign: "site@laptop", kind: "ask", ask: "q-9", options: ["main", "release", "обе"] };
  it("пуш вопроса показан с вариантами кнопками (не больше двух); пуш без вопроса — без кнопок", async () => {
    const w = worker({});
    await w.fire("push", { data: { json: () => note } });
    expect(w.shown[0]).toMatchObject({ title: "site@laptop спрашивает", o: { body: "Какую ветку?", data: note } });
    expect(w.shown[0]!.o.actions).toEqual([{ action: "answer:0", title: "main" }, { action: "answer:1", title: "release" }]);
    await w.fire("push", { data: { json: () => ({ title: "docs@laptop закончила", text: "Готово", callsign: "docs@laptop", kind: "done" }) } });
    expect(w.shown[1]!.o.actions).toEqual([]);
  });
  it("кнопка в уведомлении отвечает сессии запросом answer пропуском устройства; отказ — видимым уведомлением", async () => {
    const w = worker({ key: "home:k1a2b3:secretsecretsecret", base: "https://fleet.example" });
    await w.fire("notificationclick", { action: "answer:1", notification: { data: note, close() {} } });
    expect(w.calls[0]!.url).toBe("https://fleet.example/call");
    expect(w.calls[0]!.init.headers.authorization).toBe("Bearer home:k1a2b3:secretsecretsecret");
    expect(JSON.parse(w.calls[0]!.init.body)).toMatchObject({ type: "answer", to: "site@laptop", ask: "q-9", answer: "release" });
    expect(w.shown.at(-1)!.title).toBe("site@laptop: отвечено «release»");
    w.setReply({ ok: false, error: "already_answered" });
    await w.fire("notificationclick", { action: "answer:0", notification: { data: note, close() {} } });
    expect(w.shown.at(-1)!.title).toBe("Ответ не ушёл: на вопрос уже ответили");
  });
  it("клик по уведомлению без кнопки открывает сессию; без пропуска на устройстве ответ не уходит", async () => {
    const w = worker({});
    await w.fire("notificationclick", { action: "", notification: { data: note, close() {} } });
    expect(w.calls[0]!.url).toBe("open:/#/work/site@laptop");
    await w.fire("notificationclick", { action: "answer:0", notification: { data: note, close() {} } });
    expect(w.calls.length).toBe(1);
    expect(w.shown.at(-1)!.title).toMatch(/Ответ не ушёл: нет пропуска/);
  });
});

describe("вход", () => {
  const base = { mock: false, key: "", invite: "", ios: false, standalone: false, skippedInstall: false };
  it("экран входа: нет пропуска — приглашение; пропуск и приглашение — подтверждение замены; iPhone вне «Домой» — установка", () => {
    expect(gateOf(base)).toEqual({ screen: "invite" });
    expect(gateOf({ ...base, key: "home:k1a2b3:secretsecretsecret" })).toEqual({ screen: "connecting" });
    expect(gateOf({ ...base, invite: "home:k9z9z9:newnewnewnewnewnew" })).toEqual({ screen: "connecting" });
    expect(gateOf({ ...base, key: "home:k1a2b3:secretsecretsecret", invite: "home:k9z9z9:newnewnewnewnewnew" })).toEqual({ screen: "replace", invite: "home:k9z9z9:newnewnewnewnewnew", kid: "k1a2b3" });
    expect(gateOf({ ...base, ios: true })).toEqual({ screen: "install" });
    expect(gateOf({ ...base, ios: true, skippedInstall: true })).toEqual({ screen: "invite" });
    // с приглашением экран установки показывается и тому, кто раньше выбрал вкладку: иначе приглашение сгорит во вкладке
    expect(gateOf({ ...base, ios: true, skippedInstall: true, invite: "home:k9z9z9:newnewnewnewnewnew" })).toEqual({ screen: "install" });
    expect(gateOf({ ...base, ios: true, standalone: true, invite: "home:k9z9z9:newnewnewnewnewnew" })).toEqual({ screen: "connecting" });
    expect(gateOf({ ...base, mock: true })).toEqual({ screen: "connecting" });
  });
  it("остановка связи: отозван — с номером пропуска; устарело — перезагрузить; прочее — причиной", () => {
    expect(stopOf("revoked", "k1a2b3")).toEqual({ screen: "revoked", kid: "k1a2b3", why: "Пропуск отозван" });
    expect(stopOf("bad_key", "k1a2b3")).toMatchObject({ screen: "revoked" });
    expect(stopOf("proto", "k1")).toEqual({ screen: "outdated" });
    expect(stopOf("replaced", "k1")).toEqual({ screen: "stopped", why: "Соединение заменено другим" });
  });
  it("вставленное приглашение: само или ссылкой; не оно — пусто", () => {
    expect(apiModule.inviteFrom("  home:k9z9z9:newnewnewnewnewnew  ")).toBe("home:k9z9z9:newnewnewnewnewnew");
    expect(apiModule.inviteFrom("https://fleet.example/#invite=home%3Ak9z9z9%3Anewnewnewnewnewnew")).toBe("home:k9z9z9:newnewnewnewnewnew");
    expect(apiModule.inviteFrom("привет")).toBe("");
    expect(apiModule.inviteFrom("home:k9:short")).toBe("");
  });
  it("?open= открывает экран и уходит из адреса; приглашение в адресе важнее", () => {
    expect(openFromQuery("?open=settings/github&code=abc", "")).toEqual({ search: "?code=abc", hash: "#/settings/github" });
    expect(openFromQuery("?open=work/site@laptop", "#invite=x")).toEqual({ search: "", hash: "#invite=x" });
    expect(openFromQuery("?fleet=x", "")).toBeNull();
    expect(openFromQuery("?open=javascript:alert(1)", "")).toBeNull();
  });
  it("согласие внешнего клиента: запрос разобран, возврат — с кодом и state или с отказом", async () => {
    const a = consentOf("?client_id=https://claude.ai/oauth/client.json&redirect_uri=https://claude.ai/api/callback&code_challenge=abcdefghijklmnop1234&state=s1&code_challenge_method=S256");
    expect(a).toEqual({ client: "https://claude.ai/oauth/client.json", back: "https://claude.ai/api/callback", challenge: "abcdefghijklmnop1234", state: "s1" });
    if ("error" in a) throw new Error();
    expect(backUrl(a, { code: "home:k1:xx" })).toBe("https://claude.ai/api/callback?code=home%3Ak1%3Axx&state=s1");
    expect(backUrl(a, { error: "access_denied" })).toBe("https://claude.ai/api/callback?error=access_denied&state=s1");
    expect(consentOf("?client_id=x")).toHaveProperty("error");
    expect(consentOf("?client_id=x&redirect_uri=https://a.b/c&code_challenge=abc&code_challenge_method=plain")).toHaveProperty("error");
    const r = await ask(quiet()).call(consent, { client: a.client, back: a.back, challenge: a.challenge, label: "claude" });
    expect(r).toMatchObject({ addr: "claude~yuri@example.com", client: { name: "claude.ai" } });
    await expect(ask(quiet()).call(consent, { client: a.client, back: "http://evil.example/cb", challenge: a.challenge })).rejects.toMatchObject({ word: "bad_client" });
  });
  it("полоса «нет связи»: на какое время данные и когда следующая попытка", () => {
    const seen = new Date(2026, 10, 10, 14, 2).getTime();
    expect(offlineLine({ seen, retryAt: seen + 67_000, now: seen + 60_000, connecting: false })).toBe("Нет связи с флотом · данные на 14:02 · снова через 7 с");
    expect(offlineLine({ seen, retryAt: seen + 67_000, now: seen + 60_000, connecting: true })).toBe("Нет связи с флотом · данные на 14:02 · подключаюсь");
    expect(offlineLine({ seen: 0, now: 1, connecting: false })).toBe("Нет связи с флотом · данных ещё нет · подключаюсь");
  });
  it("настройки устройства живут в браузере и читаются обратно", () => {
    setLocal("work.view", "board");
    expect(getLocal("work.view", "list")).toBe("board");
    expect(JSON.parse(localStorage.getItem("sb2.ui.work.view")!)).toBe("board");
  });
});

describe("«Работа»", () => {
  const mine = BUILTIN[0]!, all = BUILTIN[1]!;
  it("проект сессии — из её документа, иначе от того, кто дал ей задачу", async () => {
    const p = await snap();
    expect(projectOf(p, p.sessions["site@laptop"]!)).toBe("site");
    const child: SessionRow = { ...p.sessions["wing@laptop"]!, spec: { ...p.sessions["wing@laptop"]!.spec, project: undefined } };
    expect(projectOf({ ...p, sessions: { ...p.sessions, "wing@laptop": child } }, child)).toBe("research");
    const orphan: SessionRow = { ...child, callsign: "x@laptop", by: "~other@example.com", spec: { ...child.spec, parent: undefined } };
    expect(projectOf(p, orphan)).toBe("");
  });
  it("«Мои» — свои и закреплённые чужие; свой фильтр — по состоянию, проекту и машине", async () => {
    const p = await snap();
    const foreign = p.sessions["landing@anya-pc"]!;
    expect(matches(p, foreign, mine, [])).toBe(false);
    expect(matches(p, foreign, mine, ["landing@anya-pc"])).toBe(true);
    expect(matches(p, foreign, all, [])).toBe(true);
    const f = { id: "f1", name: "Инфра ждёт", who: "all" as const, states: ["wait"], projects: ["infra"], machines: ["server"] };
    expect(rowsOf(p, f, [], []).map((s) => s.callsign).sort()).toEqual(["api@server", "audit@server", "deploy@server"]);
  });
  it("группы по проектам — в порядке человека, «Без проекта» последней; закреплённые выше", async () => {
    const p = await snap();
    const rows = rowsOf(p, all, ["migrate@server"], []);
    const names = { site: "Сайт", infra: "Инфра", research: "Исследования" };
    expect(groupsOf(p, rows, ["research", "site"], names).map((g) => g.name)).toEqual(["Исследования", "Сайт", "Инфра"]);
    expect(groupsOf(p, rows, [], names).find((g) => g.project === "infra")!.rows[0]!.callsign).toBe("migrate@server");
    const loose = { ...p, sessions: { ...p.sessions, "z@laptop": { ...p.sessions["docs@laptop"]!, callsign: "z@laptop", spec: { ...p.sessions["docs@laptop"]!.spec, project: undefined } } } };
    expect(groupsOf(loose, rowsOf(loose, all, [], []), [], names).at(-1)!.name).toBe("Без проекта");
  });
  it("перестановка: перед строкой, в конец, на шаг", () => {
    expect(reorder(["a", "b", "c"], "c", "a")).toEqual(["c", "a", "b"]);
    expect(reorder(["a", "b", "c"], "a", null)).toEqual(["b", "c", "a"]);
    expect(shift(["a", "b", "c"], "b", -1)).toEqual(["b", "a", "c"]);
    expect(shift(["a", "b", "c"], "c", 1)).toEqual(["a", "b", "c"]);
  });
  it("куда упала строка: над строкой под указателем, в конец группы, в чужую группу", () => {
    const rows = [{ id: "a", group: "site", top: 40, bottom: 80 }, { id: "b", group: "site", top: 80, bottom: 120 }, { id: "c", group: "infra", top: 160, bottom: 200 }];
    const groups = [{ group: "site", top: 10, bottom: 120 }, { group: "infra", top: 130, bottom: 200 }];
    expect(dropTarget(rows, groups, 50)).toEqual({ before: "a", group: "site", lineY: 40 });
    expect(dropTarget(rows, groups, 110)).toEqual({ before: null, group: "site", lineY: 120 });
    expect(dropTarget(rows, groups, 140)).toEqual({ before: "c", group: "infra", lineY: 160 });
    expect(dropTarget(rows, groups, 900)).toMatchObject({ before: null, group: "infra" });
    expect(dropTarget([], [], 5)).toBeNull();
  });
});

describe("аккаунты и ключи", () => {
  const acc = (id: string, o: Partial<Account> = {}): Account => ({ id, kind: "claude", email: id, ok: true, ...o });
  it("аккаунт на нескольких машинах — одна строка: лимит — большее из известного, сессии — суммой, сбой входа виден", () => {
    const m = mergeAccounts({
      laptop: [acc("a@x.io", { limits: [{ name: "five_hour", used: 0.4 }], sessions: 2 }), acc("b@x.io", { ok: false, why: "вход устарел" })],
      server: [acc("a@x.io", { limits: [{ name: "five_hour", used: 0.6, resets: 5 }], sessions: 3 }), { id: "k", kind: "key", ok: true }],
    });
    expect(m.map((x) => x.id)).toEqual(["b@x.io", "a@x.io", "k"]);
    const a = m[1]!;
    expect(a.seats.map((s) => s.machine)).toEqual(["laptop", "server"]);
    expect(a.limits).toEqual([{ name: "five_hour", used: 0.6, resets: 5 }]);
    expect(a.sessions).toBe(5);
    expect(m[0]!.ok).toBe(false);
  });
  it("«ждёт сброса» у строки — только если лимит исчерпан на всех машинах", () => {
    expect(mergeAccounts({ l: [acc("a@x.io", { wait: 900 })], s: [acc("a@x.io", { wait: 500 })] })[0]!.wait).toBe(500);
    expect(mergeAccounts({ l: [acc("a@x.io", { wait: 900 })], s: [acc("a@x.io")] })[0]!.wait).toBeUndefined();
  });
  it("пороги лимита 70 и 90; подпись окна — доля и время сброса", () => {
    expect([0.5, 0.71, 0.91].map(limitTone)).toEqual(["teal", "orange", "red"]);
    expect(limitWord({ used: 0.456, resets: new Date(2026, 0, 1, 9, 5).getTime() })).toBe("46% · до 09:05");
  });
  it("перенос аккаунта: порядок в очереди, из входов в очередь, между очередями, вон из очереди; вход под другой почтой замечен", () => {
    const slots = [{ name: "main", order: ["a", "b", "c"], sessions: 0 }, { name: "night", order: ["c"], sessions: 0 }];
    expect(queueMove(slots, "main", "main", "c", "a")).toEqual([{ slot: "main", order: ["c", "a", "b"] }]);
    expect(queueMove(slots, "main", "main", "a", "b")).toEqual([]);
    expect(queueMove(slots, null, "night", "a", null)).toEqual([{ slot: "night", order: ["c", "a"] }]);
    expect(queueMove(slots, "main", "night", "b", "c")).toEqual([{ slot: "main", order: ["a", "c"] }, { slot: "night", order: ["b", "c"] }]);
    expect(queueMove(slots, "main", "night", "c", null)).toEqual([{ slot: "main", order: ["a", "b"] }]);
    expect(queueMove(slots, "night", null, "c", null)).toEqual([{ slot: "night", order: [] }]);
    expect(seatOptions({ slots: [{ name: "main", order: ["a"], account: "a", sessions: 1 }, { name: "empty", order: ["b"], sessions: 0 }], accounts: [{ id: "orca", kind: "key", ok: true, model: "glm" }] }))
      .toEqual([{ value: "main", label: "main · a" }, { value: "empty", label: "empty · пусто", disabled: true }, { value: "orca", label: "ключ orca · glm" }]);
    expect(otherMail("a@x.io", acc("B@x.io"))).toBe(true);
    expect(otherMail("a@x.io", acc("A@X.io"))).toBe(false);
    expect(otherMail(undefined, acc("b@x.io"))).toBe(false);
  });
  it("«сменить сейчас»: названный аккаунт или следующий годный; негодный — отказ", async () => {
    const api = ask(quiet());
    await expect(api.call(slotSwap, { to: "@server", slot: "main" })).resolves.toEqual({ account: "ops@example.com" });
    await expect(api.call(slotSwap, { to: "@server", slot: "night" })).resolves.toEqual({ account: "ops@example.com" });
    await expect(api.call(slotSwap, { to: "@laptop", slot: "main", account: "work@example.com" })).rejects.toMatchObject({ word: "no_reserve" });
    await expect(api.call(slotSet, { to: "@laptop", slot: "orca-glm", order: ["yuri@example.com"] })).rejects.toMatchObject({ word: "name_taken" });
    await api.call(slotSet, { to: "@laptop", slot: "docs", order: ["yuri@example.com"] });
    expect((await api.call(accountList, { to: "@laptop" })).slots.map((q) => q.name)).toEqual(["main", "review", "docs"]);
    await expect(api.call(slotSet, { to: "@laptop", slot: "main", order: [] })).rejects.toMatchObject({ word: "has_sessions" });
    await api.call(slotSet, { to: "@laptop", slot: "docs", order: [] });
    expect((await api.call(accountList, { to: "@laptop" })).slots.map((q) => q.name)).toEqual(["main", "review"]);
  });
  it("форма ключа: пары «a = b», настройки — объект JSON, новый ключ без значения не записать, старый — можно", () => {
    expect(parsePairs("a = b\n\nплохо\n c=d = e ")).toEqual({ a: "b", c: "d = e" });
    expect(pairsText({ a: "b", c: "d" })).toBe("a = b\nc = d");
    const f = { name: "orca", provider: "openai-compatible", value: "", base: "", model: "", models: "claude-fable-5-2 = glm", window: 128000 as number | "", settings: "", env: "", isNew: true };
    expect(keyInput(f)).toEqual({ ok: false, why: "Нужно значение ключа" });
    expect(keyInput({ ...f, isNew: false })).toEqual({ ok: true, input: { name: "orca", provider: "openai-compatible", models: { "claude-fable-5-2": "glm" }, window: 128000 } });
    expect(keyInput({ ...f, value: "sk-1", settings: "[1]" })).toEqual({ ok: false, why: "Настройки сессии — объект JSON" });
    expect(keyInput({ ...f, value: "sk-1", settings: "{oops" })).toEqual({ ok: false, why: "Настройки сессии — не JSON" });
  });
  it("удаление ключа: проба называет сессии и ничего не удаляет", async () => {
    const m = quiet(), api = ask(m);
    await expect(api.call(keysRemove, { name: "meta-muse", probe: true })).resolves.toEqual({ sessions: ["wing@laptop"] });
    expect((await api.call(profileList, { to: "@laptop" })).pieces.length).toBe(4);
    await api.call(keysRemove, { name: "meta-muse" });
    await expect(api.call(keysRemove, { name: "orca-glm", probe: true })).resolves.toEqual({ sessions: [] });
  });
});

describe("профили", () => {
  it("просмотр набора: промпт, дерево, настройки с проигравшими, файлы и «не подключится»", async () => {
    const v = await ask(quiet()).call(profileView, { to: "@laptop", pieces: ["base", "web", "ops"] });
    expect(v.prompt?.agent).toMatchObject({ name: "architect", from: "base" });
    expect(v.prompt?.style?.found).toBe(false);
    expect(v.settings?.["includeCoAuthoredBy"]).toEqual({ value: false, from: "ops", lost: [{ value: true, from: "base" }] });
    expect(v.other).toContainEqual({ from: "web", path: "notes/todo.txt" });
    expect(Object.fromEntries(summary(v.items))).toMatchObject({ скилы: 6, агенты: 2, команды: 2 });
    for (const [, , kinds] of VIEW_TABS) for (const k of kinds) expect(["skill", "agent", "rule", "instructions", "mcp", "hook", "memory", "command"]).toContain(k);
  });
  it("клоны: состояние в списке; «свести сейчас» не трогает конфликт и ошибку", async () => {
    const api = ask(quiet());
    const before = (await api.call(profileList, { to: "@laptop" })).repos!;
    expect(before.map((r) => r.state)).toEqual(["ok", "ok", "conflict", "error"]);
    const after = (await api.call(profileSync, { to: "@laptop" })).repos;
    expect(after.map((r) => r.state)).toEqual(["ok", "ok", "conflict", "error"]);
    expect(after[0]!.at).toBe(T);
  });
  it("поиск кусочка — по имени, описанию и репозиторию", () => {
    const p = { id: "web", repo: "github.com/example/sb-web", title: "Веб", about: "Снимки экранов", ok: true };
    expect([pieceMatches(p, "снимки"), pieceMatches(p, "sb-web"), pieceMatches(p, " "), pieceMatches(p, "ops")]).toEqual([true, true, true, false]);
  });
});

describe("выпуски и машины", () => {
  const keeper = (state: "running" | "updating" | "failed", build: number, why?: string) => ({ build: 412, os: "linux", host: { build, state, ...(why ? { why } : {}) } });
  it("ход раскатки: без связи, ждёт план, обновляется, на сборке, сбой с причиной", () => {
    expect(rollState({ online: false, build: 410 }, 412)).toMatchObject({ lamp: "off", done: false });
    expect(rollState({ online: true, build: 411 }, 412)).toEqual({ lamp: "busy", word: "сборка 411, ждёт план 412", done: false });
    expect(rollState({ online: true, build: 411 }, 412, keeper("updating", 411))).toMatchObject({ lamp: "busy", word: "обновляется: Keeper ставит 412" });
    expect(rollState({ online: true, build: 412 }, 412, keeper("running", 412))).toEqual({ lamp: "idle", word: "на сборке 412", done: true });
    expect(rollState({ online: true, build: 411 }, 412, keeper("failed", 411, "Host дважды не запустился"))).toMatchObject({ lamp: "failed", done: false, word: expect.stringContaining("Host дважды не запустился") });
  });
  it("команда установки: приглашение идёт в stdin, для Windows и Linux — своя", () => {
    expect(installCommand("windows", "https://f.example", "home:k1:sec")).toBe('"home:k1:sec" | .\\keeper-windows-amd64.exe install --base https://f.example --logon');
    expect(installCommand("linux", "https://f.example", "home:k1:sec")).toBe("chmod +x keeper-linux-amd64 && echo 'home:k1:sec' | ./keeper-linux-amd64 install --base https://f.example");
  });
  it("инциденты: открытые или все; недоставленные — отдельно, с причиной", () => {
    const row = (id: string, state: "pending" | "taken" | "done", why?: string) => ({ id, kind: "disk", key: "/", text: id, at: Number(id), state, machine: "server", ...(why ? { why } : {}) });
    const rows = [row("1", "done"), row("2", "taken"), row("3", "pending"), row("4", "pending", "вида нет")];
    expect(splitIncidents(rows, false)).toEqual({ list: [rows[2], rows[1]], undelivered: [rows[3]] });
    expect(splitIncidents(rows, true).list.map((r) => r.id)).toEqual(["3", "2", "1"]);
  });
});

describe("архив", () => {
  const s: ArchSession = { sid: "s1", machine: "laptop", callsign: "site@laptop", title: "Шапка", cwd: "~/projects/site", points: 6, last: T };
  it("точки в ленте: точка стоит после своего хода; недогруженное начало сдвигает счёт ходов", () => {
    const rows = ["me", "reply", "res", "me", "res", "me", "reply", "res", "me"].map((k, i) => ({ k, i }));
    const parts = cutByPoints(rows, [{ point: "p1", turns: 1 }, { point: "p2", turns: 3 }]);
    expect(parts.map((p) => [p.rows.length, p.point])).toEqual([[3, "p1"], [5, "p2"], [1, undefined]]);
    expect(cutByPoints(rows, [{ point: "p9", turns: 12 }], 10).map((p) => [p.rows.length, p.point])).toEqual([[5, "p9"], [4, undefined]]);
  });
  it("период каталога — от начала суток; порядок и период уходят в запрос", async () => {
    expect(sinceOf("all")).toBeUndefined();
    const now = Date.UTC(2026, 10, 10, 15, 30);
    expect(sinceOf("7", now)).toBe(Date.UTC(2026, 10, 3));
    const api = ask(quiet());
    const recent = await api.call(pointsList, { since: T - 60 * 60_000 });
    expect(recent.sessions.every((x) => x.last >= T - 60 * 60_000)).toBe(true);
    expect(recent.sessions.length).toBeLessThan((await api.call(pointsList, {})).sessions.length);
    const big = (await api.call(pointsList, { order: "tokens" })).sessions.map((x) => x.tokens ?? 0);
    expect(big).toEqual([...big].sort((a, b) => b - a));
    expect((await api.call(pointsList, {})).sessions.find((x) => x.callsign === "site@laptop")).toMatchObject({ live: true, owner: "~yuri@example.com" });
  });
  it("проверка папки словами: клон, ветка точки, правки, чужие сессии, другой репозиторий — отказ", () => {
    const c = (folder: any, o = {}) => ({ folder, dir: "~/p", files: 0, branch: "sb/point", sessions: [] as string[], ...o });
    expect(checkWord(c("empty"), "point")).toEqual({ word: "~/p: папки нет — будет клон репозитория на ветке sb/point.", bad: false });
    expect(checkWord(c("same"), "point").word).toMatch(/встанет ветка точки sb\/point/);
    expect(checkWord(c("same"), "keep").word).toMatch(/Файлы папки не трогаются/);
    expect(checkWord(c("dirty", { files: 3 }), "point").word).toMatch(/несохранённые правки \(3 файла\)/);
    expect(checkWord(c("shared", { sessions: ["docs@laptop"] }), "point").word).toMatch(/работают docs@laptop/);
    expect(checkWord(c("other"), "point").bad).toBe(true);
  });
  it("ввод подъёма по виду: перенос — без точки и с move; копия — с именем; откат — на своей машине", () => {
    const f = { machine: "server", name: "site-copy", cwd: "~/projects/site", account: "", files: "point" as const, point: "p3" };
    expect(raiseInput("move", s, f)).toEqual({ to: "@server", sid: "s1", files: "point", move: true });
    expect(raiseInput("copy", s, { ...f, cwd: "~/else", account: "night" })).toEqual({ to: "@server", sid: "s1", files: "point", cwd: "~/else", slot: "night", name: "site-copy", point: "p3" });
    expect(raiseInput("rollback", s, { ...f, files: "keep" })).toEqual({ to: "@laptop", sid: "s1", files: "keep", point: "p3" });
    expect(raiseInput("raise", s, { ...f, name: "site", point: undefined })).toEqual({ to: "@server", sid: "s1", files: "point", move: true });
    expect(stepsOf("rollback", s, "laptop", true)[0]).toBe("Остановить site@laptop");
    expect(stepsOf("rollback", s, "laptop", false).length).toBe(2);
    expect(stepsOf("move", s, "server", true).length).toBe(3);
  });
  it("подъём: проба только проверяет; откат идущей сессии — отказ, остановленной — на месте; перенос отпускает прежнюю машину", async () => {
    const m = quiet(), api = ask(m);
    const sid = (await api.call(pointsList, { q: "шапка" })).sessions[0]!.sid;
    const dry = await api.call(pointsRaise, { to: "@server", sid, dryRun: true });
    expect(dry).toEqual({ check: { folder: "same", dir: "~/projects/site", files: 0, branch: "sb/point", sessions: [] } });
    expect(m.state.sessions["site@server"]).toBeUndefined();
    await expect(api.call(pointsRaise, { to: "@laptop", sid, point: "p2" })).rejects.toMatchObject({ word: "running" });
    await api.call(sessionStop, { to: "site@laptop" });
    await expect(api.call(pointsRaise, { to: "@laptop", sid, point: "p2" })).resolves.toEqual({ callsign: "site@laptop" });
    expect(m.state.sessions["site@laptop"]!.state).toBe("idle");
    await expect(api.call(pointsRaise, { to: "@server", sid, move: true })).resolves.toEqual({ callsign: "site@server" });
    expect(m.state.sessions["site@laptop"]).toBeUndefined();
    await expect(api.call(pointsRaise, { to: "@server", sid: "нет" })).rejects.toMatchObject({ word: "not_found" });
  });
  it("разговор архива — страницами с конца; вызовы модели у точки; удаление сверяет последнюю точку", async () => {
    const api = ask(quiet());
    const sid = (await api.call(pointsList, { q: "шапка" })).sessions[0]!.sid;
    const last = await api.call(pointsHistory, { sid, limit: 3 });
    expect(last.events.length).toBe(3);
    expect(last.more).toBe(true);
    const prev = await api.call(pointsHistory, { sid, limit: 3, before: last.events[0]!.uuid as string });
    expect(prev.events.at(-1)!.uuid).not.toBe(last.events[0]!.uuid);
    const calls = await api.call(pointsCalls, { sid, point: "p2" });
    expect(calls.point).toBe("p2");
    expect(calls.calls[0]).toMatchObject({ model: "claude-fable-5-2", input: expect.any(Number), cost: expect.any(Number) });
    await expect(api.call(pointsDelete, { sid, expect: "p1" })).rejects.toMatchObject({ word: "changed" });
    await expect(api.call(pointsDelete, { sid, expect: "p6" })).resolves.toEqual({});
  });
  it("выгрузка на свой компьютер — команда с флотом, устройством, сессией, папкой и точкой", () => {
    expect(pullCommand("home", "pult", "s3e8", "~/projects/site", "p4")).toBe("node tools/fleet/pull.ts home pult s3e8 ~/projects/site p4");
    expect(pullCommand("home", "pult", "s3e8", "./site")).toBe("node tools/fleet/pull.ts home pult s3e8 ./site");
  });
  it("«пожар»: поднимаются сессии, стоявшие на машине; сбой одной не останавливает остальные", async () => {
    const m = quiet(), api = ask(m);
    const arch = (await api.call(pointsList, { machine: "base2" })).sessions;
    const list = fireList(arch, ["crawler@base2", "backup@base2"]);
    expect(list.map((x) => x.callsign)).toEqual(["crawler@base2"]);
    const two = [...list, { ...list[0]!, sid: "нет", callsign: "ghost@base2" }];
    const seen: string[][] = [];
    const rows = await fireRun(two.reverse(), async (x) => (await api.call(pointsRaise, { to: "@server", sid: x.sid, move: true })).callsign ?? "", (r) => seen.push(r.map((x) => x.state)));
    expect(rows.map((r) => [r.s.callsign, r.state])).toEqual([["ghost@base2", "failed"], ["crawler@base2", "done"]]);
    expect(rows[1]!.word).toBe("crawler@server");
    expect(m.state.sessions["crawler@server"]).toBeDefined();
    expect(seen[0]).toEqual(["run", "wait"]);
  });
});

describe("настройки", () => {
  it("кто до каких машин достаёт: свои, общий проект, админ — до всех", async () => {
    const m = quiet();
    const { people } = await ask(m).call(peopleList, {});
    const machines = Object.values(m.state.machines);
    const of = (name: string) => reachOf(people.find((p) => p.name === name)!, people, machines).sort();
    expect(of("Аня")).toEqual(["anya-pc", "base2", "laptop", "server"]);
    expect(of("Олег")).toEqual(["base2", "laptop", "server"]);
    expect(of("Юра").length).toBe(4);
  });
  it("люди: устройства с «на связи» и «ждёт входа»; приглашение уже известного человека — отказ exists", async () => {
    const api = ask(quiet());
    const { people } = await api.call(peopleList, {});
    const oleg = people.find((p) => p.name === "Олег")!;
    expect(oleg.devices!.map((d) => [d.addr.split("~")[0], d.wait])).toEqual([["phone", false], ["pult", true]]);
    expect(people.find((p) => p.name === "Юра")!.online).toBe(true);
    await expect(api.call(invite, { addr: "pult~anya@example.com", fresh: true })).rejects.toMatchObject({ word: "exists" });
    await expect(api.call(invite, { addr: "pult~new@example.com", fresh: true })).resolves.toMatchObject({ invite: expect.stringMatching(/^home:/) });
    expect((await api.call(peopleList, {})).people.some((p) => p.person === "~new@example.com")).toBe(true);
  });
  it("пропуска: только машины или только устройства; кто пригласил — словами", async () => {
    const api = ask(quiet());
    expect((await api.call(passes, { kind: "machine" })).passes.every((p) => p.addr.startsWith("@"))).toBe(true);
    expect((await api.call(passes, { kind: "device" })).passes.some((p) => p.addr.startsWith("@"))).toBe(false);
    expect((await api.call(passes, { kids: ["k4c5d6"] })).passes.map((p) => p.addr)).toEqual(["phone~yuri@example.com"]);
    expect([byWord("pult~yuri@example.com"), byWord("site@laptop"), byWord(undefined)]).toEqual(["yuri@example.com", "site@laptop", ""]);
  });
  it("ссылка-приглашение ведёт на страницу, а не на экран согласия; QR — картинкой SVG", () => {
    expect(linkOf("home:k1:sec ret", { origin: "https://f.example", pathname: "/", search: "" })).toBe("https://f.example/#invite=home%3Ak1%3Asec%20ret");
    expect(linkOf("x", { origin: "https://f.example", pathname: "/consent", search: "?a=1" })).toBe("https://f.example/?a=1#invite=x");
    expect(qrSvg("https://f.example/#invite=home%3Ak1%3Asecret")).toMatch(/^<svg[\s\S]+<\/svg>$/);
  });
  it("правила прокси: записи флота — в форме, которую читает Host; новое правило негодно, пока нечего искать", async () => {
    const m = quiet();
    const rules = (m as any).state ? ((await m.transport.call({ type: "prefs.get", id: "1", scope: "fleet", prefix: "proxy." })).result as any).values["proxy.rules"] : [];
    expect(rules.length).toBe(3);
    for (const r of rules) expect(ProxyRule.safeParse(r).success).toBe(true);
    expect(ruleFlaw(newRule())).toBe("нечего искать");
    expect(ruleFlaw({ ...newRule(), pattern: "x", scopes: [] })).toBe("не выбрано, где искать");
    expect(ruleFlaw({ ...newRule(), pattern: "x" })).toBe("");
    expect(ruleLine(rules[0])).toBe("текст «internal.example.com» · сообщения человека, ответы инструментов · заменяет совпадение на «example.com»");
    expect(ruleLine(rules[2])).toMatch(/удаляет строку · модели glm-\*/);
  });
  it("проверка правил идёт запросом: замены, число срабатываний, негодное выражение — по имени", async () => {
    const api = ask(quiet());
    const r = await api.call(rulesTest, { to: "@laptop", text: "Счёт для ООО «Ромашка» лежит на internal.example.com", scope: "user" });
    expect(r.after).toBe("Счёт для ООО «Клиент» лежит на example.com");
    expect(r.hits).toEqual({ "Внутренние адреса": 1, "Имена клиентов": 1 });
    const bad = await api.call(rulesTest, { to: "@laptop", text: "x", rules: [{ ...newRule(), on: true, name: "Кривое", kind: "regex", pattern: "(" }] });
    expect(bad.flaws["Кривое"]).toMatch(/не разобрано/);
    expect(applyRules("a\nкарта 1111 2222 3333 4444\nb", [{ name: "К", scopes: ["user"], kind: "regex", unit: "line", action: "delete", pattern: "\\d{4} \\d{4}" }]).after).toBe("a\nb");
    expect(applyRules("x", [{ name: "М", scopes: ["user"], kind: "literal", unit: "match", action: "replace", pattern: "x", replacement: "y", models: ["glm-*"] }], "user", "claude-fable-5-2").after).toBe("x");
  });
  it("цены моделей: таблица ⇄ настройка; пустые ячейки не пишутся", () => {
    const rows = rowsOfPrices({ "claude-fable": { input: 5, output: 25 } });
    expect(rows).toEqual([{ model: "claude-fable", input: 5, output: 25, cacheRead: "", cacheWrite: "" }]);
    expect(pricesOfRows([...rows, { model: " ", input: 1, output: "", cacheRead: "", cacheWrite: "" }, { model: "glm", input: "", output: 2.2, cacheRead: "", cacheWrite: "" }])).toEqual({ "claude-fable": { input: 5, output: 25 }, glm: { output: 2.2 } });
  });
  it("бот Telegram флота: состояние, отключение, без бота код привязки не выдаётся", async () => {
    const api = ask(quiet());
    await expect(api.call(reachBot, {})).resolves.toEqual({ bot: "switchboard_fleet_bot", on: true });
    await expect(api.call(reachBot, { token: null })).resolves.toEqual({ on: false });
    await expect(api.transport.call({ type: "reach.telegram", id: "1" })).resolves.toMatchObject({ ok: false, error: "no_telegram" });
  });
  it("возврат с GitHub ведёт на экран «GitHub»", () => {
    expect(githubReturn({ origin: "https://f.example", pathname: "/" })).toBe("https://f.example/?open=settings/github");
  });
});

describe("наблюдение и журнал", () => {
  it("сводка здоровья одним ответом; ошибка страницы видна в сводке и строкой запросов", async () => {
    const api = ask(quiet());
    const h = await api.call(obsHealth, {});
    expect(h.machines).toMatchObject({ total: 4, online: 3, offline: [{ name: "base2" }] });
    expect(h.sessions.failed).toEqual(["hotfix@laptop"]);
    expect(h.requests.rate).toBeGreaterThan(0);
    expect(h.slow[0]!.p95).toBeGreaterThanOrEqual(h.slow.at(-1)!.p95);
    await api.call(obsReport, { part: "web", level: "error", msg: "Работа: Cannot read properties of undefined" });
    expect((await api.call(obsHealth, {})).reports[0]).toMatchObject({ part: "web", msg: expect.stringContaining("Работа") });
    expect((await api.call(obsRecent, { name: "report" })).rows[0]).toMatchObject({ type: "report", ok: false });
  });
  it("журнал флота: новые подтягиваются по after, повторы не дублируются; поиск по тексту, событию и машине", async () => {
    const api = ask(quiet());
    const first = (await api.call(ledgerRead, { limit: 5 })).events;
    expect(first.length).toBe(5);
    await api.transport.call({ type: "builds.deploy", id: "d", build: 411 });
    const fresh = (await api.call(ledgerRead, { after: first[0]!.at - 1 })).events;
    const merged = mergeLedger(first, fresh);
    expect(merged.length).toBe(new Set(merged.map((e) => e.id)).size);
    expect(merged[0]!.text).toMatch(/Сборка 411 назначена/);
    expect(merged.filter((e) => ledgerMatches(e, "base2")).every((e) => e.machine === "base2" || /base2/.test(e.text ?? ""))).toBe(true);
    expect(ledgerMatches(first[0]!, "такого-нет")).toBe(false);
  });
  it("по дням: «Сегодня», «Вчера», дальше — датой; порядок внутри дня сохраняется", () => {
    const now = new Date(2026, 10, 10, 12).getTime(), h = 3_600_000;
    expect([dayWord(now - h, now), dayWord(now - 20 * h, now), dayWord(now - 50 * h, now)]).toEqual(["Сегодня", "Вчера", "8 нояб."]);
    expect(byDay([now - h, now - 2 * h, now - 20 * h], (x) => x, now).map(([w, l]) => [w, l.length])).toEqual([["Сегодня", 2], ["Вчера", 1]]);
  });
  it("картина флота для модели: только названная машина", async () => {
    const r = await ask(quiet()).call(fleetList, { machine: "server" });
    expect(r.machines.map((m) => m.name)).toEqual(["server"]);
    expect(r.sessions.every((s) => s.callsign.endsWith("@server"))).toBe(true);
    expect(r.people[0]).toMatchObject({ person: "~yuri@example.com", devices: expect.arrayContaining(["pult~yuri@example.com"]) });
  });
});

describe("экраны в отрисовке", () => {
  let mock: Mock;
  function page(ui: ReactNode, at = "/work") {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(<MantineProvider><QueryClientProvider client={qc}><MemoryRouter initialEntries={[at]}><Steps /><Routes><Route path="/work/:callsign?" element={ui} /><Route path="*" element={ui} /></Routes></MemoryRouter></QueryClientProvider></MantineProvider>);
  }
  beforeEach(async () => {
    localStorage.clear();
    setLocal("work.filter", "mine");
    setLocal("work.closed", []);
    setLocal("work.view", "list");
    apiModule.connect();
    mock = apiModule.mock!;
    await new Promise<void>((done) => {
      const link = mock.transport.open("page", { onFrame: (f) => (useFleet.getState().apply(f), link.close(), done()) });
    });
  });
  afterEach(() => cleanup());

  it("«Работа»: проекты группами; свёрнутый проект помнит устройство и показывает лампы; фильтр «Все» добавляет чужие сессии", async () => {
    page(<Work />);
    // на широком экране вход открывает первую сессию рядом: смотрим сам список
    const list = () => within(screen.getByLabelText("Работа"));
    await waitFor(() => expect(list().getByText("Сайт")).toBeTruthy());
    expect(list().queryByText("Новый первый экран")).toBeNull();
    fireEvent.click(list().getByText("Сайт"));
    expect(list().queryByText("Шапка сайта на узких экранах")).toBeNull();
    expect(getLocal<string[]>("work.closed", [])).toEqual(["site"]);
    expect(document.querySelectorAll(".grp .lamps .lamp").length).toBeGreaterThan(0);
    setLocal("work.filter", "all");
    setLocal("work.closed", []);
    await waitFor(() => expect(list().getByText("Новый первый экран")).toBeTruthy());
    // чужая сессия подписана владельцем
    expect(screen.getAllByText("anya@example.com").length).toBeGreaterThan(0);
  });
  it("удаление сессии архива: кнопка ждёт ввода имени", () => {
    const onDelete = vi.fn();
    page(<DeleteTyped name="site" body="6 точек будут удалены." onDelete={onDelete} />);
    const btn = screen.getByRole("button", { name: "Удалить из архива" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "site" } });
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    expect(onDelete).toHaveBeenCalledTimes(1);
  });
  it("приглашение устройству — ссылкой с QR; программе — только кодом", () => {
    const { unmount } = page(<InviteLink invite="home:k9z9z9:newnewnewnewnewnew" />);
    expect(document.querySelector(".qr svg")).toBeTruthy();
    expect(screen.getByText(/#invite=home%3Ak9z9z9/)).toBeTruthy();
    unmount();
    page(<InviteLink invite="home:k9z9z9:newnewnewnewnewnew" program />);
    expect(document.querySelector(".qr")).toBeNull();
    expect(screen.getByText("home:k9z9z9:newnewnewnewnewnew")).toBeTruthy();
  });
});
