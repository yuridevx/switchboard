// Состояние «Работы» и его действия: выбор устройства — в снимке и хранилище страницы, настройки человека и запись проектов — в циклах prefs.
// Виды читают выборкой, меняют только действия отсюда. Выборки — model.ts.
import type { App, Params, SessionRecord } from "@switchboard/web-core";
import { createStore, folderOf, lamp, personal, type Personal } from "@switchboard/web-ui";
import { addProject, dropSessions, FLEET_PREFIX, moveProject, NONE, placeSessions, PROJECTS, removeProject, renameProject, type ProjectRec } from "@switchboard/records";
import { machineOf } from "@switchboard/protocol";
import { createModel, type State } from "./model.ts";
import { byRank, firstOpen, tree, VIEW0, type Filter, type View } from "./rules.ts";

export type BoardStore = ReturnType<typeof createBoardStore>;

export function createBoardStore() {
  let app: App;
  // циклы настроек — службы, как app: своё состояние они держат сами
  let user: Personal;
  let fleet: Personal;
  const store = createStore<State>({ menuOf: null, flt: "mine", col: {}, view: { ...VIEW0 }, lastProject: null, follow: null, listShown: false, bodyTop: 0, reordering: false }, () => app.changed());
  const state = () => store.get();
  const model = createModel({ app: () => app, user: () => user, fleet: () => fleet, state });

  const saveCol = () => void app.store<Record<string, boolean>>("collapsed").set(state().col);
  const saveView = () => void app.store<View>("view").set(state().view);
  const editProjects = (fn: (old: ProjectRec[] | undefined) => ProjectRec[]) => fleet.edit<ProjectRec[]>(PROJECTS, fn);
  const editFilters = (fn: (old: Filter[]) => Filter[]) => user.edit<Filter[]>("filters", (old) => fn(old ?? []));

  /** Открытая сессия: её проект разворачивается и становится последним. */
  function follow(callsign: string) {
    const s = model.session(callsign);
    if (!s) return;
    const project = model.projectId(callsign);
    const unfold = state().col[project] !== false;
    store.set((d) => {
      d.lastProject = model.realProject(callsign);
      if (unfold) d.col[project] = false;
    });
    if (unfold) saveCol();
  }

  /** Данные списка изменились: ждавшая открытая сессия находит проект; первый показ проекта запоминается — дальше как оставил человек. */
  function settle() {
    if (model.held()) return;
    const waiting = state().follow;
    if (waiting) {
      store.set((d) => void (d.follow = null));
      follow(waiting);
    }
    if (!state().listShown || !state().view.projects) return;
    // без сессий решать не о чем: запись проектов может прийти раньше roster, а решение — одно на проект
    const unseen = model.projects().filter((x) => state().col[x.id] === undefined && x.ss.length);
    if (!unseen.length) return;
    store.set((s) => {
      for (const x of unseen) s.col[x.id] = !firstOpen(x);
    });
    saveCol();
  }

  function pick(id: string) {
    store.set((s) => void (s.flt = id));
    void app.store<string>("flt").set(id);
    settle();
  }

  /** Закрепления прежней версии лежали на устройстве: один раз переходят к почте. Пересмотр — 1 дек. 2026: устройства перешли, убрать вместе с разделом pins. */
  async function movePins() {
    const old = await app.store<string[]>("pins").get();
    if (!old?.length) return;
    user.edit<string[]>("pins", (cur) => [...new Set([...(cur ?? []), ...old])]);
    await app.store<string[]>("pins").set([]);
  }

  return {
    ...model,
    view: () => state().view,
    filterId: () => state().flt,
    lastProject: () => state().lastProject,
    bodyTop: () => state().bodyTop,
    rowsMove: () => state().view.projects && !state().view.group,

    // ───── жизненный цикл ─────
    async start(a: App) {
      app = a;
      const prefs = () => {
        app.changed();
        settle();
      };
      user ??= personal(app, "web-board", prefs);
      fleet ??= personal(app, FLEET_PREFIX, prefs, "global");
      const [flt, col, view] = await Promise.all([app.store<string>("flt").get(), app.store<Record<string, boolean>>("collapsed").get(), app.store<View>("view").get()]);
      store.set((s) => {
        s.flt = flt ?? "mine";
        s.col = col ?? {};
        s.view = { ...VIEW0, ...view };
      });
      settle();
    },
    async stop() {
      await user?.settled();
      await fleet?.settled();
    },
    onLink(link: string) {
      if (link !== "open") return;
      void user.read().then(movePins);
      void fleet.read();
    },
    onRoster: settle,
    /** Открыт экран сессии: пока нет ответа prefs, проект неизвестен — ждёт его. */
    onCurrent(c: { params: Params }) {
      const callsign = c.params.callsign ?? null;
      if (callsign && !model.held()) follow(callsign);
      store.set((d) => void (d.follow = callsign && model.held() ? callsign : null));
    },

    // ───── список ─────
    pick,
    toggleProject(id: string) {
      store.set((s) => void (s.col[id] = !s.col[id]));
      saveCol();
    },
    setListShown(on: boolean) {
      store.set((s) => void (s.listShown = on));
      if (on) settle();
    },
    setBodyTop: (top: number) => store.set((s) => void (s.bodyTop = top)),
    setReordering: (on: boolean) => store.set((s) => void (s.reordering = on)),
    openSession(s: SessionRecord) {
      store.set((d) => void (d.lastProject = model.realProject(s.callsign)));
      // телефон: сессия с вопросом — сразу вопрос; пульт — карточка, вопрос в разговоре
      if (!app.wide && app.mark("asked", s.callsign)) app.open("ask", { callsign: s.callsign });
      else app.open("card", { callsign: s.callsign });
    },
    openNew: () => app.open("open", {}),
    /** «+» у проекта — место его верхней сессии, чья машина на связи; номер проекта страница новой сессии вернёт во вставку «после открытия», не читая. */
    newIn(id: string) {
      const x = model.projects().find((y) => y.id === id);
      const online = new Set((app.roster()?.machines ?? []).filter((m) => m.contract?.["session.open"] !== undefined).map((m) => m.machine));
      const s = x && tree(x.ss).map(([y]) => y).find((y) => online.has(machineOf(y.callsign) ?? "") && typeof y.dir === "string");
      app.open("open", { ...(s ? { machine: machineOf(s.callsign)!, dir: s.dir as string } : {}), ...(id === NONE ? {} : { project: id }) });
    },
    /** Поиск Ctrl K ведёт сразу на сессию: найденная разворачивает свой проект. */
    find: (q: string) =>
      model
        .sessions()
        .filter((s) => !q || `${s.callsign} ${model.sName(s.callsign)} ${model.mName(machineOf(s.callsign) ?? "")} ${folderOf(s.dir)} ${model.projectName(model.projectId(s.callsign))}`.toLowerCase().includes(q))
        .sort(byRank)
        .map((s) => ({ label: model.sName(s.callsign), hint: `${model.mName(machineOf(s.callsign) ?? "")} · папка ${folderOf(s.dir)}`, dot: lamp(s), screen: "card", params: { callsign: s.callsign } })),

    // ───── проекты ─────
    toggleMenu: (id: string) => store.set((s) => void (s.menuOf = s.menuOf === id ? null : id)),
    closeMenu: () => store.set((s) => void (s.menuOf = null)),
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

    // ───── закрепление ─────
    canPin(callsign: string) {
      const s = model.session(callsign);
      return !!s && !model.pins().includes(s.callsign) && !model.whyMine(s);
    },
    pin: (callsign: string) => user.edit<string[]>("pins", (old) => [...new Set([...(old ?? []), callsign])]),
    unpin: (callsign: string) => user.edit<string[]>("pins", (old) => (old ?? []).filter((c) => c !== callsign)),

    // ───── фильтры и вид ─────
    placeChips: (ids: string[]) => user.edit<string[]>("row", () => ids),
    saveFilter(clean: Filter) {
      editFilters((old) => (old.some((x) => x.id === clean.id) ? old.map((x) => (x.id === clean.id ? clean : x)) : [...old, clean]));
      pick(clean.id);
    },
    removeFilter(id: string) {
      editFilters((old) => old.filter((x) => x.id !== id));
      if (state().flt === id) pick("mine");
    },
    toggleView(k: keyof View) {
      store.set((s) => void (s.view[k] = !s.view[k]));
      saveView();
      settle();
    },
    resetView() {
      store.set((s) => void (s.view = { ...VIEW0 }));
      saveView();
      settle();
    },
  };
}
