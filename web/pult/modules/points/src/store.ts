// Точки на странице: последние ответы реестра и запросы к реестру и машинам. Своего модуль не хранит:
// линия, срок и хозяин — от реестра, подъём и точки — от машины; состояние окон — у экранов.
import type { App, SessionRecord } from "@switchboard/web-core";
import type {} from "@switchboard/web-board";
import type {} from "../../machines/contract.ts";
import { machineOf } from "@switchboard/protocol";
import { type AccountsAnswer, createStore, machinesWith, sessionOf, type SlotInfo, useModule } from "@switchboard/web-ui";

export type FleetSession = { sid: string; callsign?: string; dir?: string; owner: string; head: { id: number; at: number }; points: number; branches: number };
export type Fleet = { sessions: FleetSession[]; r2: { bytes: number; blocks: number }; sweep: { at: number; blocks: number; bytes: number } | null };
export type LinePoint = { id: number; at: number; machine: string; why: string; base: number | null; callsign?: string; dir?: string; msgs?: number; bytes?: number; git?: { state?: string; files?: number; branch?: string }; line: boolean; until: number | null };
export type Line = { owner: string | null; head: number | null; points: LinePoint[] };
export type Check = { folder: string; files?: number; branch?: string | null; sessions?: string[] };
export type CheckResult = Check | { error: string };
export type Slots = Record<string, SlotInfo>;
/** Что проверить на цели: подъём одной сессии. */
export type Raising = { sid: string; point: number | null | undefined; dir: string };
type Words = { id: number; last?: unknown[] };
type Raised = { callsign: string; point: number; folder: string; branch: string | null };

export type PointsStore = ReturnType<typeof createPointsStore>;
export const usePoints = (): PointsStore => useModule<PointsStore>();

export function createPointsStore(app: App) {
  const data = createStore<{ fleet: Fleet | null; refused: string; lines: Record<string, Line>; words: Record<number, Words> }>({ fleet: null, refused: "", lines: {}, words: {} }, () => app.changed());
  let asked = false;

  const fleet = () => data.get().fleet;

  async function readFleet() {
    const r = await app.read<Fleet>("points.list", {});
    data.set((s) => {
      if (r.ok) s.fleet = r.result;
      s.refused = r.ok ? "" : r.error;
    });
  }

  /** Машины хозяев, которых нет на связи: метка fire. */
  function lostMachines(): string[] {
    const online = new Set(machinesWith(app));
    return [...new Set((fleet()?.sessions ?? []).map((s) => s.owner))].filter((m) => !online.has(m));
  }

  async function dryRun(machine: string, sid: string, point: number, dir: string): Promise<CheckResult> {
    const r = await app.read<Check>("points.raise", { machine, sid, point, dir, files: "point", dryRun: true });
    return r.ok ? r.result : { error: r.error };
  }

  /** Слоты машины — в ответе аккаунтов. Не пришли — слово: подъём без списка ждёт, отказ машины пришёл бы после раскладки файлов. */
  async function slotsOf(machine: string): Promise<{ slots: Slots } | { error: string }> {
    if (!app.can(machine, "machine.accounts")) return { slots: {} };
    const r = await app.read<AccountsAnswer>("machine.accounts", { machine });
    return r.ok ? { slots: r.result.slots } : { error: `machine.accounts: ${r.error}` };
  }

  return {
    fleet,
    refused: () => data.get().refused,
    line: (sid: string) => (sid ? data.get().lines[sid] : undefined),
    words: (id: number) => data.get().words[id],
    session: (callsign: string): SessionRecord | undefined => sessionOf(app, callsign),
    tabVisible: (callsign: string) => app.can(machineOf(callsign) ?? "", "session.r2") === true,
    raisers: () => machinesWith(app, "points.raise"),
    lostMachines,
    /** Первый roster: без реестра метка fire не знает о машинах, ушедших до открытия страницы. */
    onRoster() {
      if (asked) return;
      asked = true;
      void readFleet();
    },
    dirOf(sid: string) {
      const line = sid ? data.get().lines[sid] : undefined;
      return line?.points.find((p) => p.id === line.head)?.dir ?? fleet()?.sessions.find((s) => s.sid === sid)?.dir ?? "~";
    },

    /** Обзор; когда ушли машины хозяев, знает модуль машин. */
    async loadFleet() {
      await readFleet();
      for (const machine of lostMachines()) app.run("machines.left.read", { machine });
    },
    /** Sid сессии по реестру; нет в памяти — реестр перечитывается. */
    async sidOf(callsign: string) {
      const find = () => fleet()?.sessions.find((s) => s.callsign === callsign)?.sid;
      if (!find()) await readFleet();
      return find() ?? "";
    },
    /** Линия и первые слова её последних точек; возврат — слово отказа. */
    async loadLine(sid: string): Promise<string> {
      const r = await app.read<Line>("points.list", { sid });
      if (!r.ok) return `points.list: ${r.error}`;
      data.set((s) => void (s.lines[sid] = r.result));
      const ids = r.result.points.slice(0, 12).map((p) => p.id).filter((id) => !data.get().words[id]);
      if (!ids.length) return "";
      const g = await app.read<{ points: Words[] }>("points.get", { ids });
      if (!g.ok) return `points.get: ${g.error}`;
      data.set((s) => {
        for (const p of g.result.points) s.words[p.id] = p;
      });
      return "";
    },
    dropLine: (sid: string) => data.set((s) => void delete s.lines[sid]),
    /** Сессия сразу уходит из обзора, затем он перечитывается. */
    async deleteSession(sid: string) {
      const r = await app.request<{ points: number }>("points.delete", { sid });
      if (r.ok) {
        data.set((s) => {
          if (s.fleet) s.fleet.sessions = s.fleet.sessions.filter((x) => x.sid !== sid);
        });
        void readFleet();
      }
      return r;
    },

    setR2: (callsign: string, on: boolean) => app.request<{ point?: number; deleted?: number }>("session.r2", { callsign, on }),
    save: (callsign: string, o: { stop?: boolean; interrupt?: boolean } = {}) => app.request<{ point: number; same: boolean }>("points.save", { callsign, ...(o.stop ? { stop: true } : {}), ...(o.interrupt ? { interrupt: true } : {}) }),
    /** Подъём; from — исходная сессия: поднятая встаёт в её проект. */
    async raise(body: Record<string, unknown>, from: string | undefined) {
      const r = await app.request<Raised>("points.raise", body);
      const project = r.ok && from ? app.mark("project.of", from)?.id : undefined;
      if (r.ok && project) app.run("board.assign", { callsign: r.result.callsign, project });
      return r;
    },
    forget: (callsign: string) => app.request("session.remove", { callsign }),
    dryRun,
    slotsOf,
    /** Цель подъёма: её слоты и проверка папки каждого подъёма. */
    async probe(machine: string, raises: Raising[]): Promise<{ slots: Slots | null; checks: CheckResult[] }> {
      const got = await slotsOf(machine);
      if ("error" in got) return { slots: null, checks: raises.map(() => ({ error: got.error })) };
      const checks = await Promise.all(raises.map((x) => (typeof x.point === "number" ? dryRun(machine, x.sid, x.point, x.dir) : { error: "bad_point" })));
      return { slots: got.slots, checks };
    },
  };
}
