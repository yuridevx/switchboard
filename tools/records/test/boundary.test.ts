// Леса границы «настройки людей и флота», сторона библиотеки records. Снаружи: служба настроек — подделка входов read и ask.
// Только входы контракта и наблюдаемый исход: новая запись, секции, запросы к службе, ответ правки. Номер — эталон-источник; без номера — чьё: код.
import { describe, expect, it } from "vitest";
import {
  addProject,
  arrange,
  dropSessions,
  FLEET_PREFIX,
  LABELS,
  labelOf,
  moveProject,
  NONE,
  placeSessions,
  PROJECTS,
  projectByName,
  projectIdOf,
  removeProject,
  renameProject,
  setLabel,
  settings,
  type ProjectRec,
} from "../contract.ts";

const REC: ProjectRec[] = [
  { id: "shop", name: "Магазин", sessions: ["api@a", "site@a", "deploy@vps"] },
  { id: "sec", name: "Безопасность", sessions: ["audit@vps"] },
];
const on = (...cs: string[]) => cs.map((callsign) => ({ callsign }));

describe("формат записей", () => {
  it("ключи области: fleet.projects и fleet.labels; номер группы «Без проекта» — ~", () => {
    expect([FLEET_PREFIX, PROJECTS, LABELS, NONE]).toEqual(["fleet", "projects", "labels", "~"]);
  });
});

describe("проекты: секции списка", () => {
  it("6101 · порядок в секции — из записи: состояния в записи нет, смена состояния ничего не переставляет", () => {
    const sections = arrange(REC, on("site@a", "api@a", "deploy@vps", "audit@vps"));
    expect(sections.map((s) => [s.id, s.name, s.callsigns])).toEqual([
      ["shop", "Магазин", ["api@a", "site@a", "deploy@vps"]],
      ["sec", "Безопасность", ["audit@vps"]],
    ]);
  });

  it("6102 · машина ушла, строка брошена, машина вернулась — сессии машины на прежних местах в записи", () => {
    const moved = placeSessions(REC, ["site@a"], "shop", "api@a");
    expect(moved[0].sessions).toEqual(["site@a", "api@a", "deploy@vps"]);
    // deploy@vps нет на экране, из записи не выпала
    expect(arrange(moved, on("site@a", "api@a")).find((s) => s.id === "shop")!.callsigns).toEqual(["site@a", "api@a"]);
    expect(arrange(moved, on("site@a", "api@a", "deploy@vps")).find((s) => s.id === "shop")!.callsigns).toEqual(["site@a", "api@a", "deploy@vps"]);
  });

  it("6104 · незаписанные: дочерняя в проекте родителя, остальные в «Без проекта» по имени и последними", () => {
    const list = [{ callsign: "z@a" }, { callsign: "b@a" }, { callsign: "kid@a", parent: "api@a" }, ...on("api@a", "audit@vps")];
    const s = arrange(REC, list);
    expect(s.map((x) => [x.id, x.name])).toEqual([["shop", "Магазин"], ["sec", "Безопасность"], [NONE, "Без проекта"]]);
    expect(s[0].callsigns).toEqual(["api@a", "kid@a"]);
    expect(s[2].callsigns).toEqual(["b@a", "z@a"]);
    expect(projectIdOf(REC, "kid@a", () => "api@a")).toBe("shop");
    expect(projectIdOf(REC, "b@a")).toBe(NONE);
  });

  it("проект сессии: родитель родителя считается; круг родителей не вешает ответ; записи нет — «Без проекта»", () => {
    const parents: Record<string, string> = { kid: "mid", mid: "api@a", x: "y", y: "x" };
    expect(projectIdOf(REC, "kid", (c) => parents[c])).toBe("shop");
    expect(projectIdOf(REC, "x", (c) => parents[c])).toBe(NONE);
    expect(projectIdOf(undefined, "api@a")).toBe(NONE);
  });

  it("6106 · пустой проект виден, «Без проекта» без сессий не показывается и всегда последний; записи нет — только «Без проекта»", () => {
    const { recs, id } = addProject(placeSessions(undefined, ["x@a"], NONE), "Новый");
    expect(recs.at(-1)!.id).toBe(NONE);
    expect(arrange(recs, on("x@a")).map((s) => s.id)).toEqual([id, NONE]);
    expect(arrange(recs, []).map((s) => s.id)).toEqual([id]);
    expect(moveProject(recs, NONE, id).at(-1)!.id).toBe(NONE);
    expect(arrange(undefined, on("x@a"))).toEqual([{ id: NONE, name: "Без проекта", callsigns: ["x@a"] }]);
    expect(arrange(undefined, [])).toEqual([]);
  });
});

describe("проекты: правки записи", () => {
  it("6103 · сессия перенесена в другой проект: в записи она ровно в одном месте; родитель едет блоком", () => {
    const r = placeSessions(REC, ["api@a", "kid@a"], "sec");
    expect(r.flatMap((x) => x.sessions).filter((c) => c === "api@a")).toHaveLength(1);
    expect(r[1].sessions).toEqual(["audit@vps", "api@a", "kid@a"]);
  });

  it("6105 · брошенная в другой проект дочерняя стоит там сама: запись важнее родителя", () => {
    const r = placeSessions(REC, ["kid@a"], "sec");
    expect(projectIdOf(r, "kid@a", () => "api@a")).toBe("sec");
  });

  it("постановка: before нет в проекте — в конец; «Без проекта» появляется в записи при первой постановке и встаёт последней; запись на входе не меняется", () => {
    expect(placeSessions(REC, ["x@a"], "sec", "нет@a")[1].sessions).toEqual(["audit@vps", "x@a"]);
    const copy = structuredClone(REC);
    placeSessions(REC, ["api@a"], "sec");
    expect(REC).toEqual(copy);
    expect(placeSessions(REC, ["x@a"], NONE).at(-1)).toEqual({ id: NONE, name: "Без проекта", sessions: ["x@a"] });
    expect(placeSessions(placeSessions(undefined, ["a@a"], NONE), ["b@a"], NONE)).toEqual([{ id: NONE, name: "Без проекта", sessions: ["a@a", "b@a"] }]);
  });

  it("6112 · бросок среди незаписанных: строка встаёт на экране там, куда брошена; записанные и чужие строки на местах", () => {
    const shown = ["a@m", "b@m", "c@m", "d@m"];
    const r = dropSessions(undefined, ["d@m"], NONE, "c@m", shown);
    expect(arrange(r, on(...shown)).at(-1)!.callsigns).toEqual(["a@m", "b@m", "d@m", "c@m"]);
    const end = dropSessions(undefined, ["a@m"], NONE, null, shown);
    expect(arrange(end, on(...shown)).at(-1)!.callsigns).toEqual(["b@m", "c@m", "d@m", "a@m"]);
    expect(dropSessions(REC, ["site@a"], "shop", "api@a", ["api@a", "site@a"])[0].sessions).toEqual(["site@a", "api@a", "deploy@vps"]);
  });

  it("бросок записывает только то, что нужно порядку: строки ниже места броска остаются незаписанными; перед записанной строкой незаписанные не записываются", () => {
    const shown = ["a@m", "b@m", "c@m", "d@m"];
    expect(dropSessions(undefined, ["d@m"], NONE, "b@m", shown)).toEqual([{ id: NONE, name: "Без проекта", sessions: ["a@m", "d@m"] }]);
    expect(dropSessions(REC, ["x@a"], "shop", "api@a", ["api@a", "loose@a", "x@a"])[0].sessions).toEqual(["x@a", "api@a", "site@a", "deploy@vps"]);
    expect(dropSessions(undefined, ["a@m"], NONE, "нет@m", shown)).toEqual([{ id: NONE, name: "Без проекта", sessions: ["a@m"] }]);
  });

  it("6107 · проект: перестановка, имя, удаление; сессии удалённого — в «Без проекта»; номер не меняется", () => {
    expect(moveProject(REC, "sec", "shop").map((r) => r.id)).toEqual(["sec", "shop"]);
    expect(moveProject(REC, "shop").map((r) => r.id)).toEqual(["sec", "shop"]);
    const r = renameProject(REC, "shop", " Лавка ");
    expect(r[0]).toMatchObject({ id: "shop", name: "Лавка" });
    expect(projectByName(r, "ЛАВКА")?.id).toBe("shop");
    const gone = removeProject(REC, "shop");
    expect(arrange(gone, on("api@a")).map((s) => [s.id, s.callsigns])).toEqual([["sec", []], [NONE, ["api@a"]]]);
    expect(addProject(REC, "shop").id).toBe("shop-2");
  });

  it("перестановка: чужой номер не меняет запись; перед «Без проекта» — последним из обычных", () => {
    const all = placeSessions(REC, ["x@a"], NONE);
    expect(moveProject(all, "нет")).toEqual(all);
    expect(moveProject(all, "shop", NONE).map((r) => r.id)).toEqual(["sec", "shop", NONE]);
    expect(moveProject(undefined, "shop")).toEqual([]);
  });

  it.each<[string, string, string, string]>([
    ["имя в номер: нижний регистр, пробелы — дефис", " Новый  Проект ", "новый-проект", "Новый  Проект"],
    ["пустое имя", "  ", "project", ""],
    ["имя как номер «Без проекта»", "~", "~-2", "~"],
  ])("новый проект: %s", (_n, name, id, shown) => {
    const r = addProject(undefined, name);
    expect(r.id).toBe(id);
    expect(r.recs).toEqual([{ id, name: shown, sessions: [] }]);
  });

  it("новый проект встаёт перед «Без проекта»; занятый номер — следующее число", () => {
    const all = placeSessions(addProject(addProject(undefined, "a").recs, "a").recs, ["x@a"], NONE);
    expect(addProject(all, "a").id).toBe("a-3");
    expect(addProject(all, "b").recs.map((r) => r.id)).toEqual(["a", "a-2", "b", NONE]);
  });

  it("«Без проекта» не переименовать, не удалить и не найти по имени; записи нет — пусто", () => {
    const all = placeSessions(REC, ["x@a"], NONE);
    expect(renameProject(all, NONE, "другое").at(-1)!.name).toBe("Без проекта");
    expect(removeProject(all, NONE).at(-1)!.id).toBe(NONE);
    expect(projectByName(all, "Без проекта")).toBeUndefined();
    expect(renameProject(undefined, "a", "b")).toEqual([]);
    expect(removeProject(undefined, "a")).toEqual([]);
    expect(projectByName(undefined, "a")).toBeUndefined();
  });
});

describe("имена", () => {
  it("6109 · имя сессии и машины ставится и снимается пустым текстом; другие имена на месте; записи нет — имени нет", () => {
    let l = setLabel(undefined, "site@a", " Витрина ");
    l = setLabel(l, "@a", "Домашний");
    expect(l).toEqual({ sessions: { "site@a": "Витрина" }, machines: { a: "Домашний" } });
    expect([labelOf(l, "site@a"), labelOf(l, "@a")]).toEqual(["Витрина", "Домашний"]);
    expect(labelOf(setLabel(l, "@a", " "), "@a")).toBeUndefined();
    expect(setLabel(l, "@a", " ").sessions).toEqual({ "site@a": "Витрина" });
    expect(labelOf(undefined, "site@a")).toBeUndefined();
    expect(labelOf({}, "@a")).toBeUndefined();
  });
});

describe("цикл настроек", () => {
  type Log = Array<[string, Record<string, unknown>]>;
  /** Подделка службы: значения одной области, журнал запросов, управляемые отказы и пауза ответа на чтение. */
  function service() {
    const values: Record<string, unknown> = {};
    const log: Log = [];
    const refuse: { get?: string; set?: Record<string, string> } = {};
    const gates: Array<() => void> = [];
    let holding = false;
    const ask = async <T,>(name: string, body: Record<string, unknown>) => {
      log.push([name, body]);
      if (name === "prefs.get") {
        if (holding) await new Promise<void>((go) => gates.push(go));
        if (refuse.get) return { ok: false as const, error: refuse.get };
        return { ok: true as const, result: { values: { ...values } } as T };
      }
      const word = refuse.set?.[body.name as string];
      if (word) return { ok: false as const, error: word };
      values[body.name as string] = body.value;
      return { ok: true as const, result: {} as T };
    };
    return {
      values,
      log,
      ask,
      refuse,
      hold: () => void (holding = true),
      release: async () => {
        holding = false;
        gates.splice(0).forEach((g) => g());
        await new Promise((r) => setTimeout(r, 0));
      },
    };
  }
  const sets = (log: Log) => log.filter(([n]) => n === "prefs.set").map(([, b]) => b);

  it("6110 · две правки подряд идут поверх свежего и не теряют друг друга; область в каждом запросе", async () => {
    const s = service();
    s.values["fleet.projects"] = [{ id: "a", name: "a", sessions: [] }];
    const c = settings({ read: s.ask, ask: s.ask, prefix: "fleet", scope: "global" });
    const one = c.edit<ProjectRec[]>("projects", (old) => placeSessions(old, ["x@m"], "a"));
    const two = c.edit<ProjectRec[]>("projects", (old) => placeSessions(old, ["y@m"], "a"));
    expect(await Promise.all([one, two])).toEqual([null, null]);
    expect((s.values["fleet.projects"] as ProjectRec[])[0].sessions).toEqual(["x@m", "y@m"]);
    expect(s.log.every(([, b]) => b.scope === "global")).toBe(true);
    // две правки одного раздела — одна запись
    expect(sets(s.log)).toHaveLength(1);
  });

  it("правка идёт поверх значения, записанного другим устройством: копия здесь устарела, чужое не теряется", async () => {
    const s = service();
    s.values["x.k"] = [1];
    const c = settings({ read: s.ask, ask: s.ask, prefix: "x" });
    await c.read();
    s.values["x.k"] = [1, 2];
    await c.edit<number[]>("k", (old) => [...(old ?? []), 3]);
    expect(s.values["x.k"]).toEqual([1, 2, 3]);
    expect(c.get("k")).toEqual([1, 2, 3]);
  });

  it("правка видна сразу, до ответа службы; звонок changed — на правку и на ответ", async () => {
    const s = service();
    let calls = 0;
    const c = settings({ read: s.ask, ask: s.ask, prefix: "x", changed: () => void calls++ });
    s.hold();
    const done = c.edit("k", () => "новое");
    expect(c.get("k")).toBe("новое");
    expect(calls).toBe(1);
    await new Promise((r) => setTimeout(r, 0));
    await s.release();
    await done;
    expect(calls).toBe(2);
  });

  it("правка, пришедшая за время цикла, остаётся поверх и уходит следующим циклом", async () => {
    const s = service();
    const c = settings({ read: s.ask, ask: s.ask, prefix: "x" });
    s.hold();
    const one = c.edit<number[]>("k", (old) => [...(old ?? []), 1]);
    await new Promise((r) => setTimeout(r, 0));
    const two = c.edit<number[]>("k", (old) => [...(old ?? []), 2]);
    expect(c.get("k")).toEqual([1, 2]);
    await s.release();
    expect(await Promise.all([one, two])).toEqual([null, null]);
    expect(s.values["x.k"]).toEqual([1, 2]);
    expect(c.get("k")).toEqual([1, 2]);
    expect(sets(s.log)).toHaveLength(2);
  });

  it("settled дожидается цикла записи: остановка не теряет правку", async () => {
    const s = service();
    const c = settings({ read: s.ask, ask: s.ask, prefix: "x" });
    await c.settled();
    s.hold();
    void c.edit("k", () => 1);
    let over = false;
    const stop = c.settled().then(() => void (over = true));
    await new Promise((r) => setTimeout(r, 0));
    expect(over).toBe(false);
    await s.release();
    await stop;
    expect(s.values["x.k"]).toBe(1);
  });

  it("6111 · отказ чтения в цикле — слово в ответе правки, записи нет; без области поля scope нет", async () => {
    const s = service();
    s.refuse.get = "gate_unavailable";
    const c = settings({ read: s.ask, ask: s.ask, prefix: "x" });
    expect(await c.edit("k", () => 1)).toBe("gate_unavailable");
    expect(sets(s.log)).toEqual([]);
    const fresh = service();
    await settings({ read: fresh.ask, ask: fresh.ask, prefix: "x" }).read();
    expect(fresh.log[0][1]).toEqual({ prefix: "x." });
  });

  it("отказ записи — слово только правке этого раздела; соседний раздел записан", async () => {
    const s = service();
    s.refuse.set = { "x.big": "too_large" };
    const c = settings({ read: s.ask, ask: s.ask, prefix: "x" });
    const [a, b] = await Promise.all([c.edit("big", () => 1), c.edit("small", () => 2)]);
    expect([a, b]).toEqual(["too_large", null]);
    expect(s.values).toEqual({ "x.small": 2 });
  });

  it("разделы одной пачки пишутся по очереди: следующий запрос уходит после ответа на прошлый", async () => {
    const s = service();
    const order: string[] = [];
    const ask = async <T,>(name: string, body: Record<string, unknown>) => {
      order.push(`${body.name} начат`);
      const r = await s.ask<T>(name, body);
      await new Promise((go) => setTimeout(go, 0));
      order.push(`${body.name} готов`);
      return r;
    };
    const c = settings({ read: s.ask, ask, prefix: "x" });
    await Promise.all([c.edit("a", () => 1), c.edit("b", () => 2)]);
    expect(order).toEqual(["x.a начат", "x.a готов", "x.b начат", "x.b готов"]);
  });

  it("7900 · чтение значений идёт входом read, запись — входом ask: у них разный предел", async () => {
    // источник: дизайн «Предел чтений и слоты», слово пользователя: таймаут на запрос метадаты 10 с
    const s = service();
    const reads: string[] = [];
    const asks: string[] = [];
    const c = settings({
      read: ((n: string, b: Record<string, unknown>) => (reads.push(n), s.ask(n, b))) as never,
      ask: ((n: string, b: Record<string, unknown>) => (asks.push(n), s.ask(n, b))) as never,
      prefix: "x",
    });
    await c.read();
    await c.edit("k", () => 1);
    expect(reads).toEqual(["prefs.get", "prefs.get"]);
    expect(asks).toEqual(["prefs.set"]);
  });

  it("7321 · чтение и цикл правки спрашивают только свои ключи области; запись — только изменённый раздел", async () => {
    // источник: отчёт слепого архитектора 4 нояб.: каждая страница читала всю область, чужие ключи ей не нужны
    const s = service();
    s.values["web-board.other"] = "не трогать";
    const c = settings({ read: s.ask, ask: s.ask, prefix: "web-board", scope: "global" });
    await c.read();
    await c.edit("top", () => 1);
    await c.settled();
    const gets = s.log.filter(([n]) => n === "prefs.get").map(([, b]) => b);
    expect(gets.length).toBe(2);
    for (const b of gets) expect(b).toEqual({ prefix: "web-board.", scope: "global" });
    expect(sets(s.log)).toEqual([{ name: "web-board.top", value: 1, scope: "global" }]);
  });

  it("чтение: значения раздела по имени; первый ответ — ready; отказ службы — тоже ответ, слово; обрыв связи ответом не считается", async () => {
    const s = service();
    s.values["x.k"] = "есть";
    let calls = 0;
    const c = settings({ read: s.ask, ask: s.ask, prefix: "x", changed: () => void calls++ });
    expect(c.ready()).toBe(false);
    expect(c.get("k")).toBeUndefined();
    expect(await c.read()).toBeNull();
    expect([c.ready(), c.get("k"), calls]).toEqual([true, "есть", 1]);

    const lost = service();
    lost.refuse.get = "disconnected";
    const l = settings({ read: lost.ask, ask: lost.ask, prefix: "x" });
    expect(await l.read()).toBe("disconnected");
    expect(l.ready()).toBe(false);

    const shut = service();
    shut.refuse.get = "gate_unavailable";
    const r = settings({ read: shut.ask, ask: shut.ask, prefix: "x" });
    expect(await r.read()).toBe("gate_unavailable");
    expect(r.ready()).toBe(true);
    expect(r.get("k")).toBeUndefined();
  });

  it("первый рисунок ждёт ответа: отказ чтения звонит changed", async () => {
    const s = service();
    s.refuse.get = "gate_unavailable";
    let calls = 0;
    await settings({ read: s.ask, ask: s.ask, prefix: "x", changed: () => void calls++ }).read();
    expect(calls).toBe(1);
  });

  it("чтение посреди цикла правки не стирает правку с экрана и не теряет её в службе", async () => {
    const s = service();
    s.values["x.k"] = "старое";
    const c = settings({ read: s.ask, ask: s.ask, prefix: "x" });
    s.hold();
    const done = c.edit("k", () => "новое");
    const reading = c.read();
    await new Promise((r) => setTimeout(r, 0));
    expect(c.get("k")).toBe("новое");
    await s.release();
    await Promise.all([done, reading]);
    expect(c.get("k")).toBe("новое");
    expect(s.values["x.k"]).toBe("новое");
  });
});
