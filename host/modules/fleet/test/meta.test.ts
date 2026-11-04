// Эталоны проектов и имён в инструментах fleet: стенд Host и подделка службы настроек.
import { afterEach, describe, expect, it } from "vitest";
import { stand } from "@switchboard/host";
import type { Frame, Manifest } from "@switchboard/host";
import manifest from "../module.json" with { type: "json" };
import { make } from "../src/fleet.ts";
import chatManifest from "../../chat/module.json" with { type: "json" };
import { make as makeChat } from "../../chat/contract.ts";
import manageManifest from "../../manage/module.json" with { type: "json" };
import { manage } from "../../manage/src/manage.ts";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { standHost } = stand;
const stands: stand.Stand[] = [];
const timers: Array<ReturnType<typeof setInterval>> = [];
afterEach(async () => {
  timers.splice(0).forEach(clearInterval);
  for (const s of stands.splice(0)) await s.close();
});

/** Подделка Worker'а prefs: отвечает на кадры области флота; down — слово отказа вместо ответа. */
function prefs(st: stand.Stand) {
  const svc = { values: {} as Record<string, unknown>, down: "" as string, scopes: new Set<unknown>() };
  const seen = new Set<unknown>();
  timers.push(
    setInterval(() => {
      for (const f of [...st.relay.frames("prefs.get"), ...st.relay.frames("prefs.set")] as Frame[]) {
        if (seen.has(f.id)) continue;
        seen.add(f.id);
        svc.scopes.add(f.scope);
        if (svc.down) st.relay.deliver({ type: "reply", id: f.id as string, from: "prefs", ok: false, error: svc.down } as Frame);
        else if (f.type === "prefs.get") st.relay.deliver({ type: "reply", id: f.id as string, from: "prefs", ok: true, result: { values: JSON.parse(JSON.stringify(svc.values)) } } as Frame);
        else {
          svc.values[f.name as string] = f.value;
          st.relay.deliver({ type: "reply", id: f.id as string, from: "prefs", ok: true } as Frame);
        }
      }
    }, 2),
  );
  return svc;
}

async function bench() {
  const home = mkdtempSync(join(tmpdir(), "switchboard-fleet-"));
  mkdirSync(join(home, "p"));
  const f = make();
  const st = await standHost({ machine: "win", home, modules: [{ manifest: chatManifest as Manifest, module: makeChat() }, { manifest: manifest as Manifest, module: f.module }, { manifest: manageManifest as Manifest, module: manage({ home }) }] });
  stands.push(st);
  const svc = prefs(st);
  const call = async (me: string, name: string, args: Record<string, unknown>) => {
    const t = f.tools(me).find((x) => x.name === name)!;
    return (await t.handler(args as never, {})) as { content: Array<{ text: string }>; isError?: boolean };
  };
  const roster = (sessions: object[]) => st.relay.deliver({ type: "roster", machines: [{ machine: "win", since: 1, proto: 1, contract: {} }], sessions, clients: [] } as Frame);
  return { st, svc, call, roster };
}

const REC = [{ id: "shop", name: "Магазин", sessions: ["site@win"] }];
const SESSIONS = [{ callsign: "site@win", state: "busy" }, { callsign: "kid@win", state: "idle", parent: "site@win" }, { callsign: "free@win", state: "idle", parent: "pult~a@b.c" }];

describe("проекты и имена в инструментах fleet", () => {
  it("6301 · list: машины с именами, проекты, у сессии имя и проект; дочерняя — в проекте родителя; область — только флот", async () => {
    const { svc, call, roster } = await bench();
    svc.values["fleet.projects"] = REC;
    svc.values["fleet.labels"] = { sessions: { "site@win": "Витрина" }, machines: { win: "Домашний ПК" } };
    roster(SESSIONS);
    const r = JSON.parse((await call("site@win", "list", {})).content[0].text);
    expect(r.machines).toEqual([{ machine: "win", label: "Домашний ПК" }]);
    expect(r.projects).toEqual(["Магазин"]);
    expect(r.sessions.map((s: { callsign: string; label: string | null; project: string | null }) => [s.callsign, s.label, s.project])).toEqual([
      ["site@win", "Витрина", "Магазин"],
      ["kid@win", null, "Магазин"],
      ["free@win", null, null],
    ]);
    expect([...svc.scopes]).toEqual(["global"]);
  });

  it("6302 · list: служба настроек не отвечает — сессии приходят, вместо меток слово причины", async () => {
    const { svc, call, roster } = await bench();
    svc.down = "gate_unavailable";
    roster(SESSIONS);
    const t = await call("site@win", "list", {});
    expect(t.isError).toBeUndefined();
    const r = JSON.parse(t.content[0].text);
    expect(r.sessions).toHaveLength(3);
    expect(r.meta).toContain("gate_unavailable");
    expect(r.projects).toEqual([]);
  });

  it("6303 · update project: сессия в конце проекта и ровно в одном месте; нет такого имени — проект создаётся; пусто — без проекта", async () => {
    const { svc, call } = await bench();
    svc.values["fleet.projects"] = [...REC, { id: "sec", name: "Безопасность", sessions: ["other@win"] }];
    expect((await call("me@win", "update", { callsign: "site@win", project: "безопасность" })).content[0].text).toContain("безопасность");
    expect(svc.values["fleet.projects"]).toEqual([{ id: "shop", name: "Магазин", sessions: [] }, { id: "sec", name: "Безопасность", sessions: ["other@win", "site@win"] }]);
    await call("me@win", "update", { callsign: "site@win", project: "Новый" });
    expect((svc.values["fleet.projects"] as Array<{ id: string; name: string; sessions: string[] }>).at(-1)).toMatchObject({ name: "Новый", sessions: ["site@win"] });
    await call("me@win", "update", { callsign: "site@win", project: "" });
    expect((svc.values["fleet.projects"] as Array<{ id: string; sessions: string[] }>).find((r) => r.id === "~")?.sessions).toEqual(["site@win"]);
    expect((svc.values["fleet.projects"] as Array<{ sessions: string[] }>).flatMap((r) => r.sessions).filter((c) => c === "site@win")).toHaveLength(1);
  });

  it("6304 · label: имя сессии и машины ставится и снимается; чужой адрес — отказ; службе не записать — слово", async () => {
    const { svc, call } = await bench();
    await call("me@win", "label", { to: "site@win", text: "Витрина" });
    await call("me@win", "label", { to: "@win", text: "Домашний ПК" });
    expect(svc.values["fleet.labels"]).toEqual({ sessions: { "site@win": "Витрина" }, machines: { win: "Домашний ПК" } });
    await call("me@win", "label", { to: "@win", text: "" });
    expect(svc.values["fleet.labels"]).toEqual({ sessions: { "site@win": "Витрина" }, machines: {} });
    expect((await call("me@win", "label", { to: "~a@b.c", text: "x" })).isError).toBe(true);
    svc.down = "gate_unavailable";
    const r = await call("me@win", "label", { to: "@win", text: "x" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("gate_unavailable");
  });

  it("6305 · open с проектом: сессия в проекте, задача во вводе; проект не записался — сессия открыта и слово в ответе; без проекта запись не меняется", async () => {
    const { st, svc, call } = await bench();
    svc.values["fleet.projects"] = REC;
    await call("site@win", "open", { name: "a", dir: "~/p", text: "задача", project: "Магазин" });
    expect((svc.values["fleet.projects"] as typeof REC)[0].sessions).toEqual(["site@win", "a@win"]);
    const before = JSON.stringify(svc.values["fleet.projects"]);
    await call("site@win", "open", { name: "b", dir: "~/p", text: "задача" });
    expect(JSON.stringify(svc.values["fleet.projects"])).toBe(before);
    svc.down = "gate_unavailable";
    const r = await call("site@win", "open", { name: "c", dir: "~/p", text: "задача", project: "Магазин" });
    expect(r.content[0].text).toContain("открыта: c@win");
    expect(r.content[0].text).toContain("gate_unavailable");
    expect(st.session("host-fleet", "c@win")).toBeTruthy();
  });

  it("6306 · две сессии одной машины ставят проект одновременно: обе правки на месте; остановка Host ждёт записи", async () => {
    const { svc, call, st } = await bench();
    svc.values["fleet.projects"] = REC;
    await Promise.all([call("a@win", "update", { callsign: "a@win", project: "Магазин" }), call("b@win", "update", { callsign: "b@win", project: "Магазин" })]);
    expect((svc.values["fleet.projects"] as typeof REC)[0].sessions.sort()).toEqual(["a@win", "b@win", "site@win"]);
    const pending = call("c@win", "update", { callsign: "c@win", project: "Магазин" });
    await st.close();
    await pending;
    expect((svc.values["fleet.projects"] as typeof REC)[0].sessions).toContain("c@win");
  });
});
