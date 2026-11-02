// web-board на стенде: «Работа» по проектам из dir, «моё» по from и parent, группы по профилям и машинам,
// машины проекта и «вне машин проекта». Источник свойств — прототип «Пульт и телефон» (подписан пользователем 2 нояб.:
// «основа дизайна ок»; комментарии: «групинг по проектам. фокус часть проекта а внутри … по профилям или машинам»).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Roster } from "@switchboard/relay";
import { createAlerts, manifest as alertsM } from "@switchboard/web-alerts";
import { createAsk, manifest as askM } from "@switchboard/web-ask";
import { createCard, manifest as cardM } from "@switchboard/web-card";
import { createChat, manifest as chatM } from "@switchboard/web-chat";
import { createBoard, manifest as boardM } from "../contract.ts";
import { memoryStore } from "@switchboard/web-core";
import { flush, homeRoster, KEY, stand } from "../../core/stand/app.ts";

const parts = () => [
  { manifest: boardM, module: createBoard() },
  { manifest: cardM, module: createCard() },
  { manifest: chatM, module: createChat() },
  { manifest: askM, module: createAsk() },
  { manifest: alertsM, module: createAlerts({}) },
];

/** Флот прототипа: switchboard на laptop, pc и build; pfarm на pc; чужая сессия anna. Я — phone~you@mail. */
function fleet(): Roster {
  const r = homeRoster();
  r.machines = [...r.machines, { machine: "build", since: 1, proto: 1, contract: r.machines[0].contract }];
  r.sessions = [
    { callsign: "refactor@laptop", state: "busy", dir: "~/Projects/switchboard", by: "pult~you@mail", model: "opus", profile: { id: "you/profiles/switchboard", state: "ok" } },
    { callsign: "tests@pc", state: "busy", dir: "~/projects/switchboard", parent: "refactor@laptop", by: "refactor@laptop", model: "sonnet", profile: { id: "you/profiles/ci", state: "ok" } },
    { callsign: "migrate@laptop", state: "waiting", dir: "~/Projects/switchboard", by: "phone~you@mail", model: "opus", profile: { id: "you/profiles/switchboard", state: "ok" } },
    { callsign: "build@build", state: "idle", dir: "~/src/switchboard", by: "pult~you@mail", model: "sonnet", profile: { id: "you/profiles/ci", state: "ok" } },
    { callsign: "api@pc", state: "idle", dir: "~/projects/pfarm", by: "alerts~you@mail", model: "opus" },
    { callsign: "docs@pc", state: "idle", dir: "~/projects/pfarm", by: "laptop~anna@mail", model: "sonnet" },
  ];
  r.clients = ["phone~you@mail", "pult~you@mail", "laptop~anna@mail"];
  return r;
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

const rows = (t: Awaited<ReturnType<typeof stand>>) => t.$$(".bd-row").map((x) => x.dataset.callsign);

describe("«Работа» по проектам", () => {
  it("5210 · проект — последнее имя папки dir на любой машине: switchboard из ~/Projects и ~/projects и ~/src — один проект", async () => {
    const t = await stand(parts(), { roster: fleet() });
    expect(t.$$(".bd-proj").map((x) => x.dataset.proj)).toEqual(["switchboard", "pfarm"]);
    expect(t.$('.bd-proj[data-proj="switchboard"]')!.textContent).toBe("switchboard4 · laptop, pc, build");
  });

  it("5211 · «моё» — from или parent с моей почтой, дочери моих; чужая — только во «Всё», с меткой «чужая»", async () => {
    const t = await stand(parts(), { roster: fleet() });
    // api@pc — от программы alerts~you@mail: моя; docs@pc — от anna: чужая
    expect(rows(t)).not.toContain("docs@pc");
    expect(rows(t)).toContain("api@pc");
    expect(rows(t)).toContain("tests@pc");
    expect(t.$('[data-foreign="1"]')!.textContent).toBe("Ещё 1 — чужие сессииВсё");
    await t.click(t.$('[data-seg="all"]'));
    expect(t.$('[data-callsign="docs@pc"] .bd-tag')!.textContent).toBe("чужая");
    expect(t.$('[data-callsign="api@pc"] .bd-tag')).toBeNull();
  });

  it("5212 · внутри проекта группы по профилям, в группе дерево по parent; по машинам — группы @машина", async () => {
    const t = await stand(parts(), { roster: fleet(), url: "/#sessions?project=switchboard" });
    expect(t.$$(".bd-grp").map((x) => x.dataset.group)).toEqual(["ci", "switchboard"]);
    // ждёт вас — выше работающей; дочь tests@pc — в группе своего профиля ci
    expect(rows(t)).toEqual(["tests@pc", "build@build", "migrate@laptop", "refactor@laptop"]);
    await t.click(t.$('[data-seg="machine"]'));
    expect(t.$$(".bd-grp").map((x) => x.dataset.group)).toEqual(["laptop", "pc", "build"]);
    expect(rows(t)).toEqual(["migrate@laptop", "refactor@laptop", "tests@pc", "build@build"]);
  });

  it("5213 · дочь под родителем в одной группе — отступ и знак ↳", async () => {
    const r = fleet();
    r.sessions[1] = { ...r.sessions[1], callsign: "tests@laptop", profile: { id: "you/profiles/switchboard", state: "ok" } };
    const t = await stand(parts(), { roster: r, url: "/#sessions?project=switchboard" });
    expect(rows(t)).toEqual(["build@build", "migrate@laptop", "refactor@laptop", "tests@laptop"]);
    const kid = t.$('[data-callsign="tests@laptop"]')!;
    expect(kid.className).toBe("bd-row kid");
    expect(kid.getAttribute("style")).toBe("padding-left:28px");
  });

  it("5214 · машины проекта: выбор устройства прячет сессии остальных машин — «Ещё N вне машин проекта»; окно «Машины проекта» возвращает", async () => {
    const store = memoryStore({ key: KEY, projects: { switchboard: ["laptop", "pc"] } });
    const t = await stand(parts(), { roster: fleet(), store, url: "/#sessions?project=switchboard" });
    expect(rows(t)).not.toContain("build@build");
    expect(t.$('[data-outside="1"]')!.textContent).toBe("Ещё 1 вне машин проектамашины проекта");
    await t.click(t.button("машины проекта"));
    expect(t.$$(".bd-fr").map((x) => x.dataset.machine)).toEqual(["build", "laptop", "pc"]);
    expect(t.$('.bd-fr[data-machine="build"]')!.getAttribute("aria-checked")).toBe("false");
    await t.click(t.$('.bd-fr[data-machine="build"]'));
    await t.click(t.button("Готово"));
    expect(rows(t)).toContain("build@build");
    expect(t.$("[data-outside]")).toBeNull();
    expect(await store.get("projects")).toEqual({ switchboard: ["laptop", "pc", "build"] });
  });

  it("5215 · колонка разделов: проекты «моего» подпунктами «Работы» с лампами; Ctrl K — проекты и сессии; строка открывает карточку", async () => {
    const t = await stand(parts(), { roster: fleet(), wide: true, options: { beside: { card: "board" } } });
    t.relay.handlers["session.watch"] = () => ({ ok: true });
    t.relay.handlers["session.history"] = () => ({ ok: true, result: { messages: [] } });
    expect(t.$$(".sb-navcol .sb-nv.sub").map((x) => x.textContent)).toEqual(["switchboard", "pfarm"]);
    expect(t.$$('.sb-navcol .sb-nv.sub')[0].querySelectorAll(".sb-dot")).toHaveLength(4);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", code: "KeyK", ctrlKey: true, bubbles: true }));
    const input = document.querySelector<HTMLInputElement>(".sb-palin")!;
    input.value = "api";
    input.dispatchEvent(new Event("input"));
    expect([...document.querySelectorAll(".sb-palit .l")].map((x) => x.textContent)).toEqual(["api@pc"]);
    document.querySelector<HTMLInputElement>(".sb-palin")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    await flush();
    await flush();
    expect(location.hash).toBe("#card?callsign=api%40pc");
  });

  it("5216 · метки для других модулей: mine — почему моя, project — проект сессии, project.machines и project.current", async () => {
    const board = createBoard();
    const t = await stand([{ manifest: boardM, module: board }, ...parts().slice(1)], { roster: fleet(), url: "/#sessions?project=pfarm" });
    const m = board.marks!;
    expect(m.mine("migrate@laptop")).toBe("задачу дали вы");
    expect(m.mine("tests@pc")).toBe("открыла ваша refactor@laptop");
    expect(m.mine("docs@pc")).toBe("");
    expect(m.project("build@build")).toBe("switchboard");
    expect(m["project.machines"]("switchboard")).toEqual(["laptop", "pc", "build"]);
    expect(m["project.current"]()).toBe("pfarm");
    void t;
  });

  it("5217 · телефон: проекты лентой сверху, проект открывается; «＋» — новая задача и на телефоне (прототип: круглая «＋» в шапке)", async () => {
    const t = await stand(parts(), { roster: fleet() });
    expect(t.$$(".bd-chips button").map((x) => x.textContent)).toEqual(["все", "switchboard4", "pfarm1"]);
    expect(t.$("[data-new]")!.textContent).toBe("＋");
    await t.click(t.$('.bd-chips [data-project="pfarm"]'));
    expect(location.hash).toBe("#sessions?project=pfarm");
    expect(rows(t)).toEqual(["api@pc"]);
  });
});
