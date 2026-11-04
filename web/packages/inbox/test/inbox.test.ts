// web-inbox на стенде: карточки «Вам» всех видов и их уход. Источник свойств — прототип «Пульт и телефон»
// (подписан пользователем 2 нояб.: «основа дизайна ок»): «Вам» выводится из roster и кадров, очереди нет; карточка
// уходит сама, когда сменилось состояние; ответ вариантом прямо из карточки.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Roster } from "@switchboard/relay";
import { createAlerts, manifest as alertsM } from "@switchboard/web-alerts";
import { createAsk, manifest as askM } from "@switchboard/web-ask";
import { createBoard, manifest as boardM } from "@switchboard/web-board";
import { createCard, manifest as cardM } from "@switchboard/web-card";
import { createChat, manifest as chatM } from "@switchboard/web-chat";
import { createInbox, manifest as inboxM } from "../contract.ts";
import { flush, homeRoster, stand } from "../../core/stand/app.ts";

const parts = () => [
  { manifest: inboxM, module: createInbox },
  { manifest: boardM, module: createBoard },
  { manifest: cardM, module: createCard },
  { manifest: chatM, module: createChat },
  { manifest: askM, module: createAsk },
  { manifest: alertsM, module: createAlerts({}) },
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

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

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

  it("5235 · машина ушла — карточка машины с моими сессиями; вернулась — карточка ушла", async () => {
    const t = await stand(parts(), { roster: fleet(), url: "/#inbox" });
    t.relay.setRoster(fleet((r) => {
      r.machines = r.machines.filter((m) => m.machine !== "pc");
      r.sessions = r.sessions.filter((s) => !s.callsign.endsWith("@pc"));
    }));
    await flush();
    expect(kinds(t)).toContain("away:pc");
    // чужая anna@pc в карточке не названа
    expect(t.$('[data-kind="away"] .ib-tx')!.textContent).toBe("night@pc");
    t.relay.setRoster(fleet());
    await flush();
    expect(kinds(t)).not.toContain("away:pc");
  });

  it("5236 · раздел «Вам» в колонке — счётчик карточек", async () => {
    const t = await stand(parts(), { roster: fleet(), wide: true });
    expect(t.$('.sb-navcol .sb-nv[data-screen="inbox"]')!.textContent).toBe("Вам2");
  });
});
