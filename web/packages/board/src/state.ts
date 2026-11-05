// Состояние «Работы» и его действия: выбор устройства — в снимке и хранилище страницы, настройки человека и запись проектов — в циклах prefs.
// Виды читают выборкой, меняют только действиями отсюда; выборки — model.ts.
import type { App, Params, SessionRecord } from "@switchboard/web-core";
import { type ConnState, createStore, folderOf, lamp, machinesWith, personal, useApp, useModule } from "@switchboard/web-ui";
import { addProject, dropSessions, FLEET_PREFIX, moveProject, NONE, placeSessions, PROJECTS, removeProject, renameProject, type ProjectRec } from "@switchboard/records";
import { machineOf } from "@switchboard/protocol";
import { createModel, type State } from "./model.ts";
import { byRank, opensFirst, tree, VIEW0, type Filter, type View } from "./rules.ts";

export type BoardState = ReturnType<typeof createBoardState>;
export const useBoard = (): BoardState => useModule<BoardState>();

/** Выборка вида: пока рисовать нельзя (ждём prefs, идёт перестановка) — прошлый ответ. */
export function useHeld<T>(select: () => T): T | undefined {
  const app = useApp();
  const board = useBoard();
  return app.use<T | undefined>((prev?: T) => (board.held() ? prev : select()));
}

export function createBoardState(app: App) {
  const store = createStore<State>({ menuOf: null, flt: "mine", col: {}, view: { ...VIEW0 }, lastProject: null, follow: null, bodyTop: 0, reordering: false }, () => app.changed());
  const state = () => store.get();
  // циклы настроек своё состояние держат сами: их ответ только будит виды
  const answered = () => {
    app.changed();
    settle();
  };
  const user = personal(app, "web-board", answered);
  const fleet = personal(app, FLEET_PREFIX, answered, "global");
  const model = createModel(app, user, fleet, state);

  const saveCollapsed = () => void app.store<Record<string, boolean>>("collapsed").set(state().col);
  const saveView = () => void app.store<View>("view").set(state().view);
  const editProjects = (fn: (old: ProjectRec[] | undefined) => ProjectRec[]) => fleet.edit<ProjectRec[]>(PROJECTS, fn);
  const editFilters = (fn: (old: Filter[]) => Filter[]) => user.edit<Filter[]>("filters", (old) => fn(old ?? []));

  /** Открытая сессия: её проект разворачивается и становится последним. */
  function follow(callsign: string) {
    if (!model.session(callsign)) return;
    const project = model.projectId(callsign);
    const unfold = state().col[project] !== false;
    store.set((d) => {
      d.lastProject = model.realProject(callsign);
      if (unfold) d.col[project] = false;
    });
    if (unfold) saveCollapsed();
  }

  /** Список на экране: открыт сам или стоит слева от открытого. */
  function listShown() {
    const c = app.current();
    return c?.screen === "board" || c?.master === "board";
  }

  /** Данные списка изменились: ждавшая открытая сессия находит проект; первый показ проекта запоминается — дальше как оставил человек. */
  function settle() {
    if (model.held()) return;
    const waiting = state().follow;
    if (waiting) {
      store.set((d) => void (d.follow = null));
      follow(waiting);
    }
    if (!listShown() || !state().view.projects) return;
    // без сессий решать не о чем: запись проектов может прийти раньше roster, а решение — одно на проект
    const unseen = model.projects().filter((x) => state().col[x.id] === undefined && x.ss.length);
    if (!unseen.length) return;
    store.set((d) => {
      for (const x of unseen) d.col[x.id] = !opensFirst(x.r);
    });
    saveCollapsed();
  }

  function pick(id: string) {
    store.set((d) => void (d.flt = id));
    void app.store<string>("flt").set(id);
    settle();
  }

  function setView(view: View) {
    store.set((d) => void (d.view = view));
    saveView();
    settle();
  }

  return {
    ...model,
    view: () => state().view,
    lastProject: () => state().lastProject,
    bodyTop: () => state().bodyTop,
    rowsMove: () => state().view.projects && !state().view.group,

    async start() {
      const [flt, col, view] = await Promise.all([app.store<string>("flt").get(), app.store<Record<string, boolean>>("collapsed").get(), app.store<View>("view").get()]);
      store.set((d) => {
        d.flt = flt ?? "mine";
        d.col = col ?? {};
        d.view = { ...VIEW0, ...view };
      });
      settle();
    },
    async stop() {
      await user.stop();
      await fleet.stop();
    },
    onLink(link: ConnState, machine?: string) {
      void user.onLink(link, machine);
      void fleet.onLink(link, machine);
    },
    onRoster: settle,
    /** Открыт экран сессии: пока нет ответа prefs, проект неизвестен — ждёт его. */
    onCurrent(c: { params: Params }) {
      const callsign = c.params.callsign ?? null;
      if (callsign && !model.held()) follow(callsign);
      store.set((d) => void (d.follow = callsign && model.held() ? callsign : null));
      settle();
    },

    pick,
    toggleProject(id: string) {
      store.set((d) => void (d.col[id] = !d.col[id]));
      saveCollapsed();
    },
    setBodyTop: (top: number) => store.set((d) => void (d.bodyTop = top)),
    setReordering: (on: boolean) => store.set((d) => void (d.reordering = on)),
    /** Телефон: сессия с вопросом — сразу вопрос; пульт — карточка, вопрос в разговоре. */
    openSession(s: SessionRecord) {
      app.open(!app.wide && app.mark("asked", s.callsign) ? "ask" : "card", { callsign: s.callsign });
    },
    openNew: () => app.open("open", {}),
    /** «+» у проекта — место его верхней сессии, чья машина на связи; номер проекта страница новой сессии вернёт вставке «после открытия», не читая. */
    newIn(id: string) {
      const x = model.projects().find((y) => y.id === id);
      const online = new Set(machinesWith(app, "session.open"));
      const top = x && tree(x.ss).map(([s]) => s).find((s) => online.has(machineOf(s.callsign) ?? "") && typeof s.dir === "string");
      app.open("open", { ...(top ? { machine: machineOf(top.callsign)!, dir: top.dir as string } : {}), ...(id === NONE ? {} : { project: id }) });
    },
    /** Поиск Ctrl K ведёт сразу на сессию. */
    find: (q: string) =>
      model
        .sessions()
        .filter((s) => !q || `${s.callsign} ${model.sName(s.callsign)} ${model.mName(machineOf(s.callsign) ?? "")} ${folderOf(s.dir)} ${model.projectName(model.projectId(s.callsign))}`.toLowerCase().includes(q))
        .sort(byRank)
        .map((s) => ({ label: model.sName(s.callsign), hint: `${model.mName(machineOf(s.callsign) ?? "")} · папка ${folderOf(s.dir)}`, dot: lamp(s), screen: "card", params: { callsign: s.callsign } })),

    toggleMenu: (id: string) => store.set((d) => void (d.menuOf = d.menuOf === id ? null : id)),
    closeMenu: () => store.set((d) => void (d.menuOf = null)),
    renameProject: (id: string, name: string) => editProjects((old) => renameProject(old, id, name)),
    /** Сессии удалённого проекта уходят в «Без проекта» и работают дальше; фильтры его больше не называют. */
    removeProject(id: string) {
      editProjects((old) => removeProject(old, id));
      editFilters((old) => old.map((f) => (f.projects?.includes(id) ? { ...f, projects: f.projects.filter((x) => x !== id) } : f)));
    },
    addProject: (name: string) => editProjects((old) => addProject(old, name).recs),
    moveProject: (id: string, before: string | null) => editProjects((old) => moveProject(old, id, before)),
    placeRows: (block: string[], project: string, before: string | null, shown: string[]) => editProjects((old) => dropSessions(old, block, project, before, shown)),
    /** Вставка места «после открытия»: страница новой сессии вернула номер проекта. */
    assign: (x: Params) => editProjects((old) => placeSessions(old, [x.callsign ?? ""], x.project ?? NONE)),

    canPin(callsign: string) {
      const s = model.session(callsign);
      return !!s && !model.pins().includes(s.callsign) && !model.whyMine(s);
    },
    pin: (callsign: string) => user.edit<string[]>("pins", (old) => [...new Set([...(old ?? []), callsign])]),
    unpin: (callsign: string) => user.edit<string[]>("pins", (old) => (old ?? []).filter((c) => c !== callsign)),

    placeChips: (ids: string[]) => user.edit<string[]>("row", () => ids),
    saveFilter(f: Filter) {
      editFilters((old) => (old.some((x) => x.id === f.id) ? old.map((x) => (x.id === f.id ? f : x)) : [...old, f]));
      pick(f.id);
    },
    removeFilter(id: string) {
      editFilters((old) => old.filter((x) => x.id !== id));
      if (state().flt === id) pick("mine");
    },
    toggleView: (k: keyof View) => setView({ ...state().view, [k]: !state().view[k] }),
    resetView: () => setView({ ...VIEW0 }),
  };
}
