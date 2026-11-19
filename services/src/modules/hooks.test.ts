// Эталоны «Входов»: адрес с секретом для событий снаружи и зов правила входа по имени. Событие идёт «Фабрике» — тикетом по правилу.
import { describe, expect, it, vi } from "vitest";
import type { Ticket } from "@sb/protocol";
import { appliedFleet } from "../../test/factory.ts";
import type { Stand } from "../../test/stand.ts";
import { drop } from "./clock/clock.ts";

/** Определение проекта «site»: пост-оператор и три правила входа — с адресом, без входа (зовут по имени) и по расписанию. */
const DEF = {
  project: "site", limit: 2,
  posts: { operator: { at: "@laptop", cwd: "~/work/post", key: "claude", model: "claude-opus-5-5", for: "1d" } },
  on: [
    { name: "losses", hook: true, to: "operator", title: "Потери на ферме" },
    { name: "model", to: "operator", title: "Ответила не та модель" },
    { name: "retro", cron: "0 9 * * 1", to: "operator" },
  ],
};
const CH = { CH_URL: "https://ch.test:8443/" };
/** Строки истории флота с таким именем: исход и данные. */
const lines = (s: Stand, msg: string): Record<string, unknown>[] =>
  s.seen.net
    .filter((n) => n.url.startsWith(CH.CH_URL) && String(n.init?.body ?? "").includes(`"msg":"${msg}"`))
    .map((n) => {
      const row = JSON.parse(String(n.init!.body)) as { kind: string; data: string };
      return { outcome: row.kind, ...(JSON.parse(row.data) as Record<string, unknown>) };
    });
const tickets = async (s: Stand) => ((await s.ask("ticket.list", { project: "site" })).result as { tickets: Ticket[] }).tickets;
const one = async (s: Stand, id: string) => ((await s.ask("ticket.list", { ticket: id })).result as { tickets: Ticket[] }).tickets[0]!;
const gives = (s: Stand) => s.seen.delivered.filter((f) => f.type === "work.give");
/** Адрес правила: путь без имени сайта и секрет из него. */
async function address(s: Stand, name = "losses") {
  const r = await s.ask("hook.url", { project: "site", name });
  expect(r).toMatchObject({ ok: true });
  const url = (r.result as { url: string }).url;
  return { url, path: new URL(url).pathname, secret: url.split("/").pop()! };
}
const post = (s: Stand, path: string, body: unknown) =>
  s.http(path, typeof body === "string" ? { method: "POST", body } : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
/** Снять тикеты и сроки проекта: на часах ничего не остаётся. */
async function finish(s: Stand) {
  for (const t of await tickets(s)) if (t.state !== "done") await s.ask("ticket.set", { ticket: t.id, drop: true });
  await drop(s.env, s.fleet, { prefix: "factory/site/" });
}

describe("входы: адрес с секретом", () => {
  // эталон 10 — чьё: факт (заметка W3C об адресах-ключах: секрет в адресе не должен попадать в журналы, отзыв — новым адресом)
  it("10 · чужой адрес закрыт: неверный секрет — 404, отозванный — 410; тикетов 0; в журнале и в истории путь без секрета", async () => {
    const { s } = await appliedFleet(DEF, CH);
    const first = await address(s);
    expect(first.url).toMatch(new RegExp(`^https://fleet\\.test/h/${s.fleet}/[A-Za-z0-9_-]{43}$`));
    // новый адрес того же правила отзывает прежний
    const second = await address(s);
    expect(second.secret).not.toBe(first.secret);
    const logged: string[] = [];
    const spies = (["log", "warn", "error"] as const).map((k) => vi.spyOn(console, k).mockImplementation((...a: unknown[]) => void logged.push(a.join(" "))));
    const wrong = "A".repeat(43);
    try {
      expect((await post(s, `/h/${s.fleet}/${wrong}`, "потери")).status).toBe(404);
      expect((await post(s, first.path, "потери")).status).toBe(410);
      // не POST и адрес не той формы — тоже «нет такого адреса»
      expect((await s.http(second.path)).status).toBe(404);
      expect((await post(s, `/h/${s.fleet}/short`, "потери")).status).toBe(404);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    expect(await tickets(s)).toEqual([]);
    expect(gives(s)).toHaveLength(0);
    const path = `/h/${s.fleet}/…`;
    // отозванный адрес — строка истории флота; чужой — строка журнала служб: флота с таким адресом может и не быть
    expect(lines(s, "hook")).toEqual([{ outcome: "410", path, project: "site", rule: "losses", status: 410 }]);
    expect(logged.filter((l) => l.includes("вход: адреса нет") && l.includes(path))).toHaveLength(1);
    const written = [...logged, ...s.seen.net.map((n) => n.url + String(n.init?.body ?? ""))].join("\n");
    for (const secret of [first.secret, second.secret, wrong]) expect(written).not.toContain(secret);
    await finish(s);
  });

  it("событие на адрес — тикет по правилу: ключ тела склеивает повторы, файл события лежит в хранилище и идёт сессии; правило снято — 404", async () => {
    const { s, file } = await appliedFleet(DEF, CH);
    const { path } = await address(s);
    const r1 = await post(s, path, { key: "map-7", text: "потеряно 4 карты", files: [{ name: "log.txt", base64: btoa("map 7: lost 4") }] });
    expect([r1.status, await r1.json()]).toEqual([202, { id: "site-1" }]);
    const t = await one(s, "site-1");
    expect(t).toMatchObject({ to: "operator", on: "losses", key: "map-7", by: ".hooks", title: "Потери на ферме", text: "потеряно 4 карты", state: "work", session: "operator@laptop", files: [{ name: "log.txt", size: 13 }] });
    const f = t.files![0]!;
    expect(await (await s.env.FILES.get(`files/${s.fleet}/${f.hash}`))!.text()).toBe("map 7: lost 4");
    expect(gives(s)).toMatchObject([{ to: "@laptop", name: "operator", ticket: "site-1", on: "losses", key: "map-7", files: [f] }]);
    // то же событие ещё раз: тикет открыт — заметка в него, новой работы нет; его файл — к файлам тикета
    const r2 = await post(s, path, { key: "map-7", text: "потеряно ещё 2", files: [{ name: "log2.txt", base64: btoa("map 7: lost 2") }] });
    expect([r2.status, await r2.json()]).toEqual([202, { id: "site-1" }]);
    const again = await one(s, "site-1");
    expect(again.notes!.map((n) => [n.by, n.text])).toEqual([[".hooks", "потеряно ещё 2"]]);
    expect(again.files!.map((x) => x.name)).toEqual(["log.txt", "log2.txt"]);
    expect(gives(s)).toHaveLength(1);
    // тело не JSON — текст события как есть, ключ — имя правила: это другой тикет
    const r3 = await post(s, path, "ферма встала");
    expect([r3.status, await r3.json()]).toEqual([202, { id: "site-2" }]);
    expect(await one(s, "site-2")).toMatchObject({ key: "losses", text: "ферма встала", state: "ready" });
    // битое тело — отказ словом
    const bad = await s.http(path, { method: "POST", headers: { "content-type": "application/json" }, body: "{" });
    expect([bad.status, ((await bad.json()) as { error: string }).error]).toEqual([400, "bad_frame"]);
    const broken = await post(s, path, { text: "с файлом", files: [{ name: "x.bin", base64: "@@не base64@@" }] });
    expect([broken.status, ((await broken.json()) as { error: string }).error]).toEqual([400, "bad_frame"]);
    expect(lines(s, "hook").map((l) => l.status)).toEqual([202, 202, 202, 400, 400]);
    expect(lines(s, "rule").map((l) => [l.source, l.outcome, l.ticket])).toEqual([["hook", "ticket", "site-1"], ["hook", "note", "site-1"], ["hook", "ticket", "site-2"]]);
    // правило снято из определения: адрес ещё есть, а события больше некуда — 404; новый адрес ему не выдаётся
    file.text = JSON.stringify({ ...DEF, on: DEF.on.filter((r) => r.name !== "losses") });
    file.sha = "c2";
    expect(await s.ask("factory.apply", { project: "site", repo: "team/roles" })).toMatchObject({ ok: true });
    const gone = await post(s, path, "потери");
    expect([gone.status, ((await gone.json()) as { error: string }).error]).toEqual([404, "no_rule"]);
    expect(await s.ask("hook.url", { project: "site", name: "losses" })).toMatchObject({ ok: false, error: "no_rule" });
    expect(await tickets(s)).toHaveLength(2);
    await finish(s);
  });

  it("адрес выдаётся участнику проекта и только правилу с адресом", async () => {
    const { s } = await appliedFleet(DEF);
    expect(await s.ask("hook.url", { project: "site", name: "model" })).toMatchObject({ ok: false, error: "no_rule" });
    expect(await s.ask("hook.url", { project: "site", name: "ghost" })).toMatchObject({ ok: false, error: "no_rule" });
    expect(await s.ask("hook.url", { project: "site", name: "losses" }, "koleg1")).toMatchObject({ ok: false, error: "forbidden" });
    expect(await s.ask("hook.url", { project: "site", name: "losses" }, "kanya1")).toMatchObject({ ok: true });
    await finish(s);
  });
});

describe("входы: правило зовут по имени", () => {
  // чьё: дизайн «Фабрика», принят словом пользователя 19 нояб. («делай»): обращения самой машины зовут правило входа по имени; три одинаковых подряд — один тикет
  it("машина шлёт событие по имени правила — тикет; три события с одним ключом — тикет один; правила нет — отказ словом", async () => {
    const { s } = await appliedFleet(DEF, CH);
    const say = (key: string, text: string) => s.ask("ticket.new", { project: "site", on: "model", key, text }, "klaptop");
    const drift = "poe1-manager@laptop: в документе модель claude-opus-5-5, ответила claude-sonnet-5-5";
    for (let i = 0; i < 3; i++) expect(await say("poe1-manager@laptop", drift)).toMatchObject({ ok: true, result: { id: "site-1" } });
    expect(await tickets(s)).toMatchObject([{ id: "site-1", to: "operator", on: "model", key: "poe1-manager@laptop", by: "@laptop", title: "Ответила не та модель", text: drift, state: "work" }]);
    expect((await one(s, "site-1")).notes).toHaveLength(2);
    expect(gives(s)).toMatchObject([{ name: "operator", ticket: "site-1", on: "model", key: "poe1-manager@laptop" }]);
    // другой ключ — другой тикет: оператор занят, тикет ждёт очереди
    expect(await say("docs@laptop", "docs@laptop: ответила не та модель")).toMatchObject({ ok: true, result: { id: "site-2" } });
    expect(lines(s, "rule").map((l) => [l.source, l.outcome, l.ticket, l.by])).toEqual([
      ["name", "ticket", "site-1", "@laptop"], ["name", "note", "site-1", "@laptop"], ["name", "note", "site-1", "@laptop"], ["name", "ticket", "site-2", "@laptop"],
    ]);
    // по имени зовётся любое правило — и то, у которого есть свой вход
    expect(await s.ask("ticket.new", { project: "site", on: "retro" })).toMatchObject({ ok: true, result: { id: "site-3" } });
    expect(await s.ask("ticket.new", { project: "site", on: "ghost", text: "x" }, "klaptop")).toMatchObject({ ok: false, error: "no_rule" });
    // событие правила не несёт исполнителя и названия; обычному тикету название нужно
    expect(await s.ask("ticket.new", { project: "site", on: "model", title: "Своё название" })).toMatchObject({ ok: false, error: "bad_input" });
    expect(await s.ask("ticket.new", { project: "site", text: "без названия" })).toMatchObject({ ok: false, error: "bad_input" });
    await finish(s);
  });
});
