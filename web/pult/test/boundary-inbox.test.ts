// Леса границы «обзор флота на странице»: «Вам» — что ждёт человека — настоящие модули на поддельном relay.
// Вход — экран, адрес, кадры relay и записи хранилища; исход — запросы к relay, текст и якоря разметки (классы и data-* — контракт экрана: их читают стили и снимки).
// Номер — эталон-источник; без номера — чьё: код.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppModule, Manifest, Roster } from "@switchboard/web-core";
import { createAlerts, manifest as alertsM } from "@switchboard/web-alerts";
import { createAsk, manifest as askM } from "@switchboard/web-ask";
import { createBoard, manifest as boardM } from "@switchboard/web-board";
import { createCard, manifest as cardM } from "@switchboard/web-card";
import { createChat, manifest as chatM } from "@switchboard/web-chat";
import { createInbox, manifest as inboxM } from "@switchboard/web-inbox";
import { FakeRelay, flush, homeRoster, stand } from "../../packages/core/stand/app.ts";
import { createMachines, manifest as machinesM } from "../modules/machines/contract.ts";
import { fleetRelay, fleetRoster, pult } from "./stand.ts";

vi.setConfig({ testTimeout: 20_000 });

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("Вам", () => {
  const parts = () => [
    { manifest: inboxM, module: createInbox },
    { manifest: boardM, module: createBoard },
    { manifest: cardM, module: createCard },
    { manifest: chatM, module: createChat },
    { manifest: askM, module: createAsk },
    { manifest: alertsM, module: createAlerts({}) },
    // когда машина ушла, знает её владелец: настоящий модуль машин
    { manifest: machinesM, module: createMachines },
  ];

  /** Я — phone~you@mail. Мои: site, wait, fail; чужая — anna. */
  function fleet(over: (r: Roster) => void = () => {}): Roster {
    const r = homeRoster();
    r.sessions = [
      { callsign: "site@laptop", state: "busy", dir: "~/Projects/site", by: "phone~you@mail" },
      { callsign: "night@pc", state: "idle", dir: "~/projects/pfarm", by: "pult~you@mail", slot: { name: "night", wait: 1_900_000_000 } },
      { callsign: "catan@laptop", state: "failed", dir: "~/Projects/catan", by: "pult~you@mail", failed: { host: "процесс claude завершился дважды до готовности" } },
      { callsign: "anna@pc", state: "failed", dir: "~/projects/pfarm", by: "laptop~anna@mail" },
    ];
    r.clients = ["phone~you@mail", "laptop~anna@mail"];
    over(r);
    return r;
  }

  const kinds = (t: Awaited<ReturnType<typeof stand>>) => t.$$(".ib-it").map((x) => `${x.dataset.kind}:${x.dataset.callsign ?? x.dataset.machine ?? ""}`);

  describe("«Вам»", () => {
    it("5230 · «не запустилась» и «ждёт сброса лимита» — только у моих сессий; счётчик раздела; чужая сессия карточки не даёт", async () => {
      const t = await stand(parts(), { roster: fleet(), url: "/#inbox" });
      expect(kinds(t)).toEqual(["fail:catan@laptop", "wait:night@pc"]);
      expect(t.$('[data-kind="fail"] .ib-tx')!.textContent).toBe("host: процесс claude завершился дважды до готовности");
      expect(t.$('[data-kind="wait"] .ib-tx')!.textContent).toMatch(/^Аккаунты слота night у порога — продолжит после \d\d:\d\d$/);
      expect(t.$$(".ib-gh").map((x) => x.textContent)).toEqual(["Сломалось или ждёт · 2"]);
      // сессия поднялась, слот сменился — карточки ушли сами
      t.relay.setRoster(fleet((r) => {
        r.sessions[2] = { ...r.sessions[2], state: "idle", failed: undefined };
        r.sessions[1] = { ...r.sessions[1], slot: { name: "main", wait: null } };
      }));
      await flush();
      expect(kinds(t)).toEqual([]);
      expect(t.text()).toContain("Всё разобрано");
    });

    it("5231 · «Запустить снова» — session.start; отказ — словом", async () => {
      const t = await stand(parts(), { roster: fleet(), url: "/#inbox" });
      t.relay.handlers["session.start"] = () => ({ ok: false, error: "no_slot" });
      await t.click(t.button("Запустить снова"));
      expect(t.relay.sent("session.start")[0]).toMatchObject({ callsign: "catan@laptop" });
      expect(t.$(".sb-toast")!.textContent).toBe("catan@laptop не запустилась: no_slot");
      expect(kinds(t)).toContain("fail:catan@laptop");
    });

    it("5232 · вопрос — ответ вариантом прямо из карточки; answered убирает карточку", async () => {
      const t = await stand(parts(), { roster: fleet(), url: "/#inbox" });
      const q = { question: "q1", kind: "ask", questions: [{ question: "База?", options: [{ label: "стенд" }, { label: "прод" }] }] };
      let waiting = [q];
      t.relay.handlers["question.list"] = () => ({ ok: true, result: waiting });
      t.relay.handlers.answer = () => ((waiting = []), { ok: true, result: {} });
      t.relay.push({ type: "question", from: "anna@pc", ...q });
      await flush();
      // вопрос виден и у чужой сессии: кому — решает Host
      expect(kinds(t)[0]).toBe("q:anna@pc");
      await t.click(t.$$(".ib-it .ask-opt")[0]);
      await t.click(t.button("Ответить"));
      expect(t.relay.sent("answer")[0]).toMatchObject({ callsign: "anna@pc", question: "q1", answers: { "База?": "стенд" } });
      t.relay.push({ type: "answered", from: "anna@pc", question: "q1", by: "pult~you@mail", answers: { "База?": "стенд" } });
      await flush();
      expect(kinds(t)).not.toContain("q:anna@pc");
    });

    it("5233 · сообщение вам — карточка с текстом; «Открыть» — карточка сессии, сообщение прочитано", async () => {
      const t = await stand(parts(), { roster: fleet(), url: "/#inbox" });
      t.relay.handlers["session.watch"] = () => ({ ok: true });
      t.relay.handlers["session.history"] = () => ({ ok: true, result: { messages: [] } });
      t.relay.push({ type: "message", from: "site@laptop", text: "Почистить кэш npm?" });
      await flush();
      expect(kinds(t)[0]).toBe("msg:site@laptop");
      expect(t.$('[data-kind="msg"] .ib-tx')!.textContent).toBe("Почистить кэш npm?");
      await t.click(t.$('[data-kind="msg"] button.pri'));
      expect(location.hash).toBe("#card?callsign=site%40laptop");
    });

    it("5234 · «готово»: моя сессия busy → idle, пока её не смотрят; «Прочитано» убирает; новый ход — снова", async () => {
      const t = await stand(parts(), { roster: fleet(), url: "/#inbox" });
      t.relay.setRoster(fleet((r) => (r.sessions[0] = { ...r.sessions[0], state: "idle" })));
      await flush();
      expect(kinds(t)).toContain("done:site@laptop");
      expect(t.$$(".ib-gh").map((x) => x.textContent)).toContain("Готово · 1");
      await t.click(t.button("Прочитано"));
      expect(kinds(t)).not.toContain("done:site@laptop");
      t.relay.setRoster(fleet());
      await flush();
      t.relay.setRoster(fleet((r) => (r.sessions[0] = { ...r.sessions[0], state: "idle" })));
      await flush();
      expect(kinds(t)).toContain("done:site@laptop");
    });

  });

  it("V-I1 · подписи: «Ждут ответа» с числом, «пишет вам», «спрашивает», проект сессии рядом", async () => {
    const relay = new FakeRelay(fleet());
    (relay as unknown as { scoped: unknown }).scoped = { global: { "fleet.projects": [{ id: "p1", name: "Сайт", sessions: ["site@laptop"] }] } };
    relay.handlers["question.list"] = () => ({ ok: true, result: [] });
    const t = await stand(parts(), { relay, url: "/#inbox" });
    t.relay.push({ type: "message", from: "site@laptop", text: "Готово?" });
    await flush(5);
    expect(t.$$(".ib-gh").map((x) => x.textContent)[0]).toBe("Ждут ответа · 1");
    expect(t.$('[data-kind="msg"] .ib-lb')!.textContent).toBe("пишет вам · Сайт");
    expect(t.$('[data-kind="fail"] .ib-lb')!.textContent).toBe("не запустилась");
    expect(t.$('[data-kind="wait"] .ib-lb')!.textContent).toBe("ждёт сброса лимита");
  });

  it("D-1 · «Почему» на телефоне ведёт к причине: «Ещё» со строкой сбоя; на пульте причина — на плашке карточки", async () => {
    // источник: спорное место сноса, опыт: кнопка «Почему» открывала чат, причины на экране не было
    const open = async (wide: boolean) => {
      const relay = new FakeRelay(fleet());
      relay.handlers["session.watch"] = () => ({ ok: true });
      relay.handlers["session.history"] = () => ({ ok: true, result: { messages: [] } });
      relay.handlers["question.list"] = () => ({ ok: true, result: [] });
      const t = await stand(parts(), { relay, url: "/#inbox", wide, options: wide ? { beside: { card: "board" } } : {} });
      await t.click([...t.$('[data-kind="fail"]')!.querySelectorAll("button")].find((b) => b.textContent === "Почему")!);
      await flush(5);
      return t;
    };
    const phone = await open(false);
    expect(phone.$(".card-info")!.textContent).toContain("сбойhost: процесс claude завершился дважды до готовности");
    const wide = await open(true);
    expect(wide.$(".cw-pl b")!.textContent).toBe("Не запустилась: host: процесс claude завершился дважды до готовности");
  });
});

describe("Вам: виды карточек", () => {
  const parts = (extra: Array<{ manifest: Manifest; module: () => AppModule }> = []) => [
    { manifest: inboxM, module: createInbox },
    { manifest: boardM, module: createBoard },
    { manifest: cardM, module: createCard },
    { manifest: chatM, module: createChat },
    { manifest: askM, module: createAsk },
    { manifest: alertsM, module: createAlerts({}) },
    // когда машина ушла, знает её владелец: настоящий модуль машин
    { manifest: machinesM, module: createMachines },
    ...extra,
  ];

  /** Подделка модуля точек: метка fire — какие машины не на связи; экран точек нужен только как цель кнопки. */
  const points = (fire: string[]) => ({
    manifest: { name: "pult-points", type: "web", version: "1.0.0", provides: { fire: 2, points: 1 }, uses: {} } as Manifest,
    module: () => ({ marks: { fire: () => fire }, screens: { points: { nav: "Точки", label: "Точки", view: () => null } } }) as AppModule,
  });

  /** Я — phone~you@mail. site и mine@pc мои; anna@pc чужая. */
  function fleet(over: (r: Roster) => void = () => {}): Roster {
    const r = homeRoster();
    r.sessions = [
      { callsign: "site@laptop", state: "busy", dir: "~/Projects/site", by: "phone~you@mail" },
      { callsign: "mine@pc", state: "idle", dir: "~/p", by: "phone~you@mail" },
      { callsign: "anna@pc", state: "busy", dir: "~/p", by: "laptop~anna@mail" },
    ];
    r.clients = ["phone~you@mail", "laptop~anna@mail"];
    over(r);
    return r;
  }
  const idle = (r: Roster, i = 0) => void (r.sessions[i] = { ...r.sessions[i], state: "idle" });

  type T = Awaited<ReturnType<typeof stand>>;
  const kinds = (t: T) => t.$$(".ib-it").map((x) => `${x.dataset.kind}:${x.dataset.callsign ?? x.dataset.machine ?? ""}`);
  const withRelay = async (o: Parameters<typeof stand>[1] = {}, list = parts()) => {
    const t = await stand(list, o);
    t.relay.handlers["session.watch"] ??= () => ({ ok: true });
    t.relay.handlers["session.unwatch"] ??= () => ({ ok: true });
    t.relay.handlers["session.history"] ??= () => ({ ok: true, result: { messages: [] } });
    t.relay.handlers["question.list"] ??= () => ({ ok: true, result: [] });
    return t;
  };

  describe("«готово»", () => {
    it("6960 · открыли карточку сессии — «готово» снято переходом и не возвращается", async () => {
      // источник: устав — части пользуются контрактом; чьё: код
      const t = await withRelay({ roster: fleet(), url: "/#inbox" });
      t.relay.setRoster(fleet((r) => idle(r)));
      await flush();
      expect(kinds(t)).toContain("done:site@laptop");
      await t.go("#card?callsign=site%40laptop");
      await t.go("#inbox");
      expect(kinds(t)).not.toContain("done:site@laptop");
    });

    it("6961 · сессию смотрят, когда она закончила — «готово» не появляется", async () => {
      // источник: чьё: код
      const t = await withRelay({ roster: fleet(), url: "/#card?callsign=site%40laptop" });
      t.relay.setRoster(fleet((r) => idle(r)));
      await flush();
      await t.go("#inbox");
      expect(t.text()).toContain("Всё разобрано");
      expect(kinds(t)).not.toContain("done:site@laptop");
    });

    it("6963 · «Прочитано»: метка «Вам» меньше на одну; новый roster с той же idle карточку не возвращает", async () => {
      // источник: чьё: код
      const t = await withRelay({ roster: fleet(), wide: true, url: "/#inbox" });
      const nav = () => t.$('.sb-navcol .sb-nv[data-screen="inbox"]')!.textContent;
      t.relay.setRoster(fleet((r) => idle(r)));
      await flush();
      expect(nav()).toBe("Вам1");
      await t.click(t.button("Прочитано"));
      expect(nav()).toBe("Вам");
      t.relay.setRoster(fleet((r) => idle(r)));
      await flush();
      expect(kinds(t)).not.toContain("done:site@laptop");
    });

    it("6964 · чужая сессия закончила, упала или ждёт лимит — карточек нет", async () => {
      // источник: чьё: код
      const t = await withRelay({ roster: fleet(), url: "/#inbox" });
      expect(t.text()).toContain("Всё разобрано");
      t.relay.setRoster(fleet((r) => idle(r, 2)));
      await flush();
      expect(kinds(t)).toEqual([]);
      t.relay.setRoster(fleet((r) => (r.sessions[2] = { ...r.sessions[2], state: "failed", slot: { name: "main", wait: 1_900_000_000 } })));
      await flush();
      expect(kinds(t)).toEqual([]);
    });
  });

  describe("вопрос и сообщение", () => {
    it("6965 · вопрос и сообщение — у чужой тоже; у одной сессии и то и другое — только вопрос", async () => {
      // источник: устав — AskUserQuestion получают зрители сессии; чьё: код
      const t = await withRelay({ roster: fleet(), url: "/#inbox" });
      const ask = (from: string, id: string) => ({ type: "question", from, to: ["phone"], question: id, kind: "ask", questions: [{ question: `Вопрос ${from}?`, header: "В", options: [{ label: "да" }] }] });
      t.relay.handlers["question.list"] = (f) => ({ ok: true, result: f.callsign === "anna@pc" ? [ask("anna@pc", "q1")] : f.callsign === "site@laptop" ? [ask("site@laptop", "q2")] : [] });
      t.relay.push(ask("anna@pc", "q1"));
      t.relay.push({ type: "message", from: "mine@pc", to: "phone", text: "Готов отчёт" });
      t.relay.push(ask("site@laptop", "q2"));
      t.relay.push({ type: "message", from: "site@laptop", to: "phone", text: "И сообщение" });
      await flush();
      expect(kinds(t).sort()).toEqual(["msg:mine@pc", "q:anna@pc", "q:site@laptop"]);
      expect(t.$('[data-kind="msg"]')!.textContent).toContain("Готов отчёт");
    });
  });

  describe("машины", () => {
    const without = (r: Roster, m: string) => {
      r.machines = r.machines.filter((x) => x.machine !== m);
      r.sessions = r.sessions.filter((s) => !s.callsign.endsWith(`@${m}`));
    };

    it("6967 · ушла машина с моими сессиями: «не на связи с ЧЧ:ММ», только мои, «Поднять из точки»", async () => {
      // источник: устав — соединение с объектом машины оборвалось
      const t = await withRelay({ roster: fleet(), url: "/#inbox" }, parts([points(["pc"])]));
      t.relay.setRoster(fleet((r) => without(r, "pc")));
      await flush();
      const card = t.$('[data-kind="away"]')!;
      expect(card.textContent).toMatch(/не на связи с \d\d:\d\d/);
      expect(card.querySelector(".ib-tx")!.textContent).toBe("mine@pc");
      expect(card.textContent).toContain("Поднять из точки");
      // модуля точек в сборке нет — поднимать некуда
      const bare = await withRelay({ roster: fleet(), url: "/#inbox" });
      bare.relay.setRoster(fleet((r) => without(r, "pc")));
      await flush();
      expect(bare.$('[data-kind="away"]')!.textContent).not.toContain("Поднять из точки");
    });

    it("6968 · ушла машина только с чужими сессиями — карточки нет", async () => {
      // источник: чьё: код
      const t = await withRelay({ roster: fleet((r) => (r.sessions = r.sessions.filter((s) => s.callsign !== "mine@pc"))), url: "/#inbox" });
      t.relay.setRoster(fleet((r) => without(r, "pc")));
      await flush();
      expect(kinds(t)).toEqual([]);
      expect(t.text()).toContain("Всё разобрано");
    });

    it("6969 · машины ушли до открытия: метка fire — три машины, при открытом ушла одна из них — «машин не на связи: 2» и «Поднять из точки»", async () => {
      // источник: факт — ушли раньше, чем открыто приложение, знает модуль точек
      const t = await withRelay({ roster: fleet(), url: "/#inbox" }, parts([points(["old1", "old2", "pc"])]));
      t.relay.setRoster(fleet((r) => without(r, "pc")));
      await flush();
      const fire = t.$('[data-kind="fire"]')!;
      expect(fire.textContent).toContain("машин не на связи: 2");
      expect(fire.textContent).toContain("Поднять из точки");
    });

    it("7250 · время ухода — у владельца: карточка показывает время из метки machines.gone, а не считает своё", async () => {
      // источник: гейт архитектора «дубликат состояния не пропускается»
      const at = new Date(2026, 10, 4, 3, 7).getTime();
      const gone = {
        manifest: { name: "pult-machines", type: "web", version: "1.0.0", provides: { "machines.gone": 1 }, uses: {} } as Manifest,
        module: () => ({ marks: { "machines.gone": () => ({ pc: at }) } }) as AppModule,
      };
      const t = await withRelay({ roster: fleet(), url: "/#inbox" }, parts().filter((p) => p.manifest.name !== "pult-machines").concat(gone));
      expect(t.$('[data-kind="away"]')!.textContent).toContain("не на связи с 03:07");
    });

  });

  it("V-I2 · имя сессии в карточке открывает её; «Поднять из точки» — экран точек, в обеих карточках машин", async () => {
    const t = await withRelay({ roster: fleet((r) => (r.sessions[1] = { ...r.sessions[1], state: "failed" })), url: "/#inbox" }, parts([points(["pc", "old"])]));
    await t.click(t.$('[data-kind="fail"] .ib-cs'));
    expect(location.hash).toBe("#card?callsign=mine%40pc");
    await t.go("#inbox");
    await t.click(t.$('[data-kind="fire"] button.pri'));
    expect(location.hash).toBe("#points");
    await t.go("#inbox");
    t.relay.setRoster(fleet((r) => {
      r.machines = r.machines.filter((x) => x.machine !== "pc");
      r.sessions = r.sessions.filter((x) => !x.callsign.endsWith("@pc"));
    }));
    await flush(5);
    await t.click(t.$('[data-kind="away"] button.pri'));
    expect(location.hash).toBe("#points");
  });
});

describe("Найдено сверкой деревьев", () => {
  // источник: чьё: код — разметка и правила, которые снимки и прежние леса не держали; сверка деревьев старого и нового кода 5 нояб.
  it("«Вам»: готово после запуска, но не после ответа на вопрос; карточка лимита — зелёная лампа", async () => {
    const r = fleetRoster();
    const at = (state: string, slot?: unknown) => ({ ...r, sessions: r.sessions.map((s) => (s.callsign === "wiki@laptop" ? { ...s, state, ...(slot ? { slot } : {}) } : s)) });
    const relay = fleetRelay(at("starting"));
    relay.handlers["question.list"] = () => ({ ok: true, result: [] });
    const t = await pult({ relay, url: "/#inbox" });
    await flush(5);
    relay.setRoster(at("idle"));
    await flush(5);
    expect(t.$('[data-kind="done"][data-callsign="wiki@laptop"]')).not.toBeNull();
    await t.click(t.btn(t.$('[data-kind="done"]'), "Прочитано"));
    relay.setRoster(at("waiting"));
    await flush(5);
    relay.setRoster(at("idle", { name: "night", wait: 1_900_000_000 }));
    await flush(5);
    expect(t.$('[data-kind="done"]')).toBeNull();
    expect(t.$('[data-kind="wait"] .sb-dot')!.className).toContain("idle");
  });
});
