// Состояние точек: ответы реестра в памяти модуля и запросы шагов. Своих данных модуль не хранит: линия, ветки, срок и хозяин — от реестра points,
// подъём и точки — host-points машины. Состояние окон — у самих экранов.
import type { App, SessionRecord } from "@switchboard/web-core";
import type {} from "@switchboard/web-board";
import type {} from "../../machines/contract.ts";
import { machineOf } from "@switchboard/protocol";
import { createStore, machinesWith, sessionOf, type SlotsAnswer, useModule } from "@switchboard/web-ui";

export type FleetSession = { sid: string; callsign?: string; dir?: string; owner: string; head: { id: number; at: number }; points: number; branches: number };
export type Fleet = { sessions: FleetSession[]; r2: { bytes: number; blocks: number }; sweep: { at: number; blocks: number; bytes: number } | null };
type Git = { state?: string; files?: number; branch?: string };
export type LPoint = { id: number; at: number; machine: string; why: string; base: number | null; callsign?: string; dir?: string; msgs?: number; bytes?: number; git?: Git; line: boolean; until: number | null };
export type Line = { owner: string | null; head: number | null; points: LPoint[] };
export type Full = { id: number; last?: unknown[] };
export type Check = { folder: string; files?: number; branch?: string | null; sessions?: string[] };
export type CheckResult = Check | { error: string };

type State = {
  fleet: Fleet | null;
  /** слово отказа последнего points.list реестра */
  fleetRefused: string;
  /** реестр уже спрошен при первом roster */
  fleetAsked: boolean;
  lines: Record<string, Line>;
  full: Record<number, Full>;
};

type Raised = { callsign: string; point: number; folder: string; branch: string | null };
type SaveOptions = { stop?: boolean; interrupt?: boolean };

export type PointsStore = ReturnType<typeof createPointsStore>;
/** Стор модуля в экранах. */
export const usePoints = (): PointsStore => useModule<PointsStore>();

export function createPointsStore(app: App) {
  const store = createStore<State>({ fleet: null, fleetRefused: "", fleetAsked: false, lines: {}, full: {} }, () => app.changed());

  const fleet = () => store.get().fleet;
  const session = (callsign: string): SessionRecord | undefined => sessionOf(app, callsign);
  const onlineMachines = () => new Set(machinesWith(app));

  async function readRegistry() {
    const r = await app.request<Fleet>("points.list", {});
    store.set((s) => {
      if (r.ok) s.fleet = r.result;
      s.fleetRefused = r.ok ? "" : r.error;
    });
  }

  /** «Пожар»: машины хозяев, которых нет в roster. */
  function fireMachines(): string[] {
    const on = onlineMachines();
    return [...new Set((fleet()?.sessions ?? []).map((s) => s.owner))].filter((m) => !on.has(m));
  }

  /** Обзор: реестр; когда ушли машины хозяев, знает модуль машин. */
  async function loadFleet() {
    await readRegistry();
    for (const machine of fireMachines()) app.run("machines.left.read", { machine });
  }

  /** Проверка подъёма: что будет с папкой на целевой машине. */
  async function dry(m: string, sid: string, point: number, dir: string): Promise<CheckResult> {
    const r = await app.request<Check>("points.raise", { machine: m, sid, point, dir, files: "point", dryRun: true });
    return r.ok ? r.result : { error: r.error };
  }

  return {
    // ───── выборки ─────
    fleet,
    fleetRefused: () => store.get().fleetRefused,
    line: (sid: string) => (sid ? store.get().lines[sid] : undefined),
    full: (id: number) => store.get().full[id],
    session,
    /** Вкладка «Точки» видна, когда машина сессии умеет точки. */
    canTab: (callsign: string) => app.can(machineOf(callsign) ?? "", "session.r2") === true,
    /** Машины, умеющие подъём. */
    raisers: () => machinesWith(app, "points.raise"),
    /** Метка fire: машины с сессиями в R2, которых нет в roster. */
    fireMachines,
    /** Первый roster: реестр один раз, без него fire не знает о машинах, ушедших до открытия приложения. */
    onRoster() {
      if (store.get().fleetAsked) return;
      store.set((s) => void (s.fleetAsked = true));
      void readRegistry();
    },
    /** Папка сессии: у последней точки, иначе в реестре. */
    dirOf(sid: string) {
      const line = sid ? store.get().lines[sid] : undefined;
      return line?.points.find((p) => p.id === line.head)?.dir ?? fleet()?.sessions.find((s) => s.sid === sid)?.dir ?? "~";
    },

    // ───── реестр ─────
    loadFleet,
    /** Сессия в реестре; нет в памяти — обзор перечитывается. */
    async sidOf(callsign: string) {
      if (!fleet()?.sessions.some((s) => s.callsign === callsign)) await readRegistry();
      return fleet()?.sessions.find((s) => s.callsign === callsign)?.sid ?? "";
    },
    /** Линия сессии и первые слова её последних точек. Возврат — слово отказа. */
    async loadLine(sid: string) {
      const r = await app.request<Line>("points.list", { sid });
      if (r.ok) store.set((s) => void (s.lines[sid] = r.result));
      let word = r.ok ? "" : `points.list: ${r.error}`;
      // первые слова — поле last точек на экране; машина для этого не нужна
      const known = store.get().full;
      const ids = (r.ok ? r.result.points : [])
        .slice(0, 12)
        .map((p) => p.id)
        .filter((id) => !known[id]);
      if (ids.length) {
        const g = await app.request<{ points: Full[] }>("points.get", { ids });
        if (g.ok) {
          store.set((s) => {
            for (const p of g.result.points) s.full[p.id] = p;
          });
        } else word = `points.get: ${g.error}`;
      }
      return word;
    },
    dropLine: (sid: string) => store.set((s) => void delete s.lines[sid]),
    /** Удалить точки сессии: сразу уходит из обзора, затем обзор перечитывается. */
    async deleteSession(sid: string) {
      const r = await app.request<{ points: number }>("points.delete", { sid });
      if (r.ok) {
        store.set((s) => {
          if (s.fleet) s.fleet.sessions = s.fleet.sessions.filter((x) => x.sid !== sid);
        });
        void readRegistry();
      }
      return r;
    },

    // ───── машина ─────
    setR2: (callsign: string, on: boolean) => app.request<{ point?: number; deleted?: number }>("session.r2", { callsign, on }),
    savePoint: (callsign: string, o: SaveOptions = {}) => app.request<{ point: number; same: boolean }>("points.save", { callsign, ...(o.stop ? { stop: true } : {}), ...(o.interrupt ? { interrupt: true } : {}) }),
    /** Подъём; from — исходная сессия: поднятая встаёт в её проект, команду записи держит «Работа». */
    async raise(body: Record<string, unknown>, from: string | null | undefined) {
      const r = await app.request<Raised>("points.raise", body);
      const project = r.ok && from ? app.mark("project.of", from)?.id : undefined;
      if (r.ok && project) app.run("board.assign", { callsign: r.result.callsign, project });
      return r;
    },
    forget: (callsign: string) => app.request("session.remove", { callsign }),
    dry,
    /** Что будет на целевой машине: её слоты и проверка папки каждого подъёма. Отказ слотов — словом проверки: без него подъём ушёл бы без слота, на вход машины. */
    async probe(m: string, raises: Array<{ sid: string; point: number | null | undefined; dir: string }>): Promise<{ slots: string[] | null; checks: CheckResult[] }> {
      let slots: string[] = [];
      if (app.can(m, "machine.slots")) {
        const r = await app.request<SlotsAnswer>("machine.slots", { machine: m });
        if (!r.ok) return { slots: null, checks: raises.map(() => ({ error: `machine.slots: ${r.error}` })) };
        slots = Object.keys(r.result.slots ?? {});
      }
      const checks = await Promise.all(raises.map((x) => (typeof x.point === "number" ? dry(m, x.sid, x.point, x.dir) : { error: "bad_point" })));
      return { slots, checks };
    },
  };
}
