import { describe, expect, it } from "vitest";
import { addProject, arrange, dropSessions, firstFill, labelOf, moveProject, NONE, placeSessions, projectByName, projectIdOf, removeProject, renameProject, setLabel, settings, type Ask, type ProjectRec } from "../contract.ts";

const REC: ProjectRec[] = [
  { id: "shop", name: "Магазин", sessions: ["api@a", "site@a", "deploy@vps"] },
  { id: "sec", name: "Безопасность", sessions: ["audit@vps"] },
];
const on = (...cs: string[]) => cs.map((callsign) => ({ callsign }));

describe("проекты", () => {
  it("6101 · порядок в секции — из записи: состояния в записи нет, смена состояния ничего не переставляет", () => {
    const sections = arrange(REC, on("site@a", "api@a", "deploy@vps", "audit@vps"));
    expect(sections.map((s) => [s.id, s.callsigns])).toEqual([["shop", ["api@a", "site@a", "deploy@vps"]], ["sec", ["audit@vps"]]]);
  });

  it("6102 · машина ушла, строка брошена, машина вернулась — сессии машины на прежних местах в записи", () => {
    const moved = placeSessions(REC, ["site@a"], "shop", "api@a");
    expect(moved[0].sessions).toEqual(["site@a", "api@a", "deploy@vps"]);
    // deploy@vps нет на экране, из записи не выпала
    expect(arrange(moved, on("site@a", "api@a")).find((s) => s.id === "shop")!.callsigns).toEqual(["site@a", "api@a"]);
    expect(arrange(moved, on("site@a", "api@a", "deploy@vps")).find((s) => s.id === "shop")!.callsigns).toEqual(["site@a", "api@a", "deploy@vps"]);
  });

  it("6103 · сессия перенесена в другой проект: в записи она ровно в одном месте; родитель едет блоком", () => {
    const r = placeSessions(REC, ["api@a", "kid@a"], "sec");
    expect(r.flatMap((x) => x.sessions).filter((c) => c === "api@a")).toHaveLength(1);
    expect(r[1].sessions).toEqual(["audit@vps", "api@a", "kid@a"]);
  });

  it("6104 · незаписанные: дочерняя в проекте родителя, остальные в «Без проекта» по имени и последними", () => {
    const list = [{ callsign: "z@a" }, { callsign: "b@a" }, { callsign: "kid@a", parent: "api@a" }, ...on("api@a", "audit@vps")];
    const s = arrange(REC, list);
    expect(s.map((x) => x.id)).toEqual(["shop", "sec", NONE]);
    expect(s[0].callsigns).toEqual(["api@a", "kid@a"]);
    expect(s[2].callsigns).toEqual(["b@a", "z@a"]);
    expect(projectIdOf(REC, "kid@a", () => "api@a")).toBe("shop");
    expect(projectIdOf(REC, "b@a")).toBe(NONE);
  });

  it("6105 · брошенная в другой проект дочерняя стоит там сама: запись важнее родителя", () => {
    const r = placeSessions(REC, ["kid@a"], "sec");
    expect(projectIdOf(r, "kid@a", () => "api@a")).toBe("sec");
  });

  it("6106 · пустой проект виден, «Без проекта» без сессий не показывается и всегда последний", () => {
    const { recs, id } = addProject(placeSessions(undefined, ["x@a"], NONE), "Новый");
    expect(recs.at(-1)!.id).toBe(NONE);
    expect(arrange(recs, on("x@a")).map((s) => s.id)).toEqual([id, NONE]);
    expect(arrange(recs, []).map((s) => s.id)).toEqual([id]);
    expect(moveProject(recs, NONE, id).at(-1)!.id).toBe(NONE);
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

  it("6112 · бросок среди незаписанных: строка встаёт на экране там, куда брошена; записанные и чужие строки на местах", () => {
    const shown = ["a@m", "b@m", "c@m", "d@m"];
    const r = dropSessions(undefined, ["d@m"], NONE, "c@m", shown);
    expect(arrange(r, on(...shown)).at(-1)!.callsigns).toEqual(["a@m", "b@m", "d@m", "c@m"]);
    const end = dropSessions(undefined, ["a@m"], NONE, null, shown);
    expect(arrange(end, on(...shown)).at(-1)!.callsigns).toEqual(["b@m", "c@m", "d@m", "a@m"]);
    expect(dropSessions(REC, ["site@a"], "shop", "api@a", ["api@a", "site@a"])[0].sessions).toEqual(["site@a", "api@a", "deploy@vps"]);
  });

  it("6108 · первое заполнение: папки — проекты с тем же номером, top — начальный порядок, домашняя — вне записи; пустой состав — пусто", () => {
    const list = [{ callsign: "a@w", folder: "bot" }, { callsign: "b@w", folder: "shop" }, { callsign: "c@w", folder: "shop" }, { callsign: "h@w", folder: NONE }];
    expect(firstFill(list, ["shop"])).toEqual([{ id: "shop", name: "shop", sessions: ["b@w", "c@w"] }, { id: "bot", name: "bot", sessions: ["a@w"] }]);
    expect(firstFill([])).toEqual([]);
  });
});

describe("имена", () => {
  it("6109 · имя сессии и машины ставится и снимается пустым текстом", () => {
    let l = setLabel(undefined, "site@a", " Витрина ");
    l = setLabel(l, "@a", "Домашний");
    expect([labelOf(l, "site@a"), labelOf(l, "@a")]).toEqual(["Витрина", "Домашний"]);
    expect(labelOf(setLabel(l, "@a", " "), "@a")).toBeUndefined();
  });
});

describe("цикл настроек", () => {
  /** Подделка службы: значения одной области и журнал запросов. */
  function service() {
    const values: Record<string, unknown> = {};
    const log: Array<[string, Record<string, unknown>]> = [];
    const ask: Ask = async <T,>(name: string, body: Record<string, unknown>) => {
      log.push([name, body]);
      if (name === "prefs.get") return { ok: true, result: { values: { ...values } } as T };
      values[body.name as string] = body.value;
      return { ok: true, result: {} as T };
    };
    return { values, log, ask };
  }

  it("6110 · две правки подряд идут поверх свежего и не теряют друг друга; область в каждом запросе", async () => {
    const s = service();
    s.values["fleet.projects"] = [{ id: "a", name: "a", sessions: [] }];
    const c = settings({ ask: s.ask, prefix: "fleet", scope: "global" });
    const one = c.edit<ProjectRec[]>("projects", (old) => placeSessions(old, ["x@m"], "a"));
    const two = c.edit<ProjectRec[]>("projects", (old) => placeSessions(old, ["y@m"], "a"));
    expect(await Promise.all([one, two])).toEqual([null, null]);
    expect((s.values["fleet.projects"] as ProjectRec[])[0].sessions).toEqual(["x@m", "y@m"]);
    expect(s.log.every(([, b]) => b.scope === "global")).toBe(true);
  });

  it("6111 · отказ службы — слово в ответе правки; без области поля scope нет", async () => {
    const ask: Ask = async () => ({ ok: false, error: "gate_unavailable" });
    const c = settings({ ask, prefix: "x" });
    expect(await c.edit("k", () => 1)).toBe("gate_unavailable");
    const s = service();
    await settings({ ask: s.ask, prefix: "x" }).read();
    expect(s.log[0][1]).toEqual({});
  });
});
