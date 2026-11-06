// Состояние «Работы»: настройки у почты и флота, разделы устройства, правки. Всё остальное считается из roster.
import type { App, Params } from "@switchboard/web-ui";
import type { SessionRecord } from "@switchboard/web-core";
import { machineOf } from "@switchboard/protocol";
import { addProject, arrange, dropSessions, FLEET_PREFIX, moveProject, NONE, placeSessions, PROJECTS, projectIdOf, removeProject, renameProject, type ProjectRec } from "@switchboard/records";
import { createStore, folderOf, lamp, machineLabel, myAddress, personal, sessionLabel } from "@switchboard/web-ui";
import { BUILT_IN, byUrgency, chipsOrder, matches, ownerOf, VIEW, whyMine, type Facts, type Filter, type Section, type View } from "./model.ts";

type Device = { flt: string; collapsed: Record<string, boolean>; view: View; current: string | null };

/** Экраны сессии: открытая разворачивает свой проект. */
const OF_SESSION = ["card", "chat", "ask"];

export function createState(app: App) {
  const device = createStore<Device>({ flt: "mine", collapsed: {}, view: VIEW, current: null }, () => app.changed());
  const changed = () => {
    reveal();
    app.changed();
  };
  const own = personal(app, "web-board", changed);
  const fleet = personal(app, FLEET_PREFIX, changed, "global");
  /** сессия открытого экрана ждёт ответа настроек */
  let wanted: string | null = null;

  const sessions = (): SessionRecord[] => app.roster()?.sessions ?? [];
  const records = () => fleet.get<ProjectRec[]>(PROJECTS);
  const filters = () => own.get<Filter[]>("filters") ?? [];
  const pins = () => own.get<string[]>("pins") ?? [];
  const parentOf = (callsign: string) => sessions().find((s) => s.callsign === callsign)?.parent as string | undefined;
  const projectOf = (callsign: string) => projectIdOf(records(), callsign, parentOf);
  const ready = () => own.ready() && fleet.ready();
  const mine = (callsign: string) => whyMine({ sessions: sessions(), me: myAddress(app), pins: pins() }, callsign);
  const facts: Facts = { mine: (c) => !!mine(c), owner: (c) => ownerOf(sessions(), c), project: projectOf };

  const chips = () => chipsOrder(own.get<string[]>("row"), [...BUILT_IN, ...filters()]);
  const selected = (): Filter => filters().find((f) => f.id === device.get().flt) ?? (device.get().flt === "all" ? BUILT_IN[1] : BUILT_IN[0]);
  /** условие чипа: «Моё» — мои, «Всё» — без условий */
  const conditions = (f: Filter): Partial<Filter> => (f.id === "mine" ? { who: ["mine"] } : f);
  const fitting = (f: Partial<Filter>) => sessions().filter((s) => matches(f, s, facts));
  const sections = (): Section[] => arrange(records(), sessions() as Array<{ callsign: string; parent?: string | null }>);

  /** Секции под фильтром: проект без подходящих скрыт, пустой по записи — виден. */
  function shown(f: Partial<Filter>): Section[] {
    const fit = new Set(fitting(f).map((s) => s.callsign));
    return sections().flatMap((s) => {
      const callsigns = s.callsigns.filter((c) => fit.has(c));
      return callsigns.length || !s.callsigns.length ? [{ ...s, callsigns }] : [];
    });
  }

  function setCollapsed(changes: Record<string, boolean>) {
    device.set((d) => void Object.assign(d.collapsed, changes));
    void app.store("collapsed").set(device.get().collapsed);
  }

  /** Открыта сессия: её проект — последний и развёрнут. Настроек ещё нет — дождётся ответа; ушли с экрана — забыто. */
  function reveal() {
    if (!wanted || !ready()) return;
    const id = projectOf(wanted);
    wanted = null;
    device.set((d) => void (d.current = id === NONE ? null : id));
    if (device.get().collapsed[id] !== false) setCollapsed({ [id]: false });
  }

  /** Первый показ: проект развёрнут, если в нём ждут вас или сбой; дальше как оставил человек. */
  function firstShow(list: Section[]) {
    if (!ready()) return;
    const urgent = (c: string) => ["waiting", "failed"].includes(sessions().find((s) => s.callsign === c)?.state as string);
    const fresh = list.filter((s) => s.callsigns.length && device.get().collapsed[s.id] === undefined);
    if (fresh.length) setCollapsed(Object.fromEntries(fresh.map((s) => [s.id, !s.callsigns.some(urgent)])));
  }

  async function load() {
    const [f, c, v] = await Promise.all([app.store<string>("flt").get(), app.store<Record<string, boolean>>("collapsed").get(), app.store<Partial<View>>("view").get()]);
    device.set((d) => {
      d.flt = f ?? "mine";
      d.collapsed = c ?? {};
      d.view = { ...VIEW, ...v };
    });
  }

  function setView(next: View) {
    device.set((d) => void (d.view = next));
    void app.store("view").set(next);
  }

  function pick(id: string) {
    device.set((d) => void (d.flt = id));
    void app.store("flt").set(id);
  }

  const editFleet = (fn: (recs: ProjectRec[] | undefined) => ProjectRec[]) => fleet.edit<ProjectRec[]>(PROJECTS, fn);

  return {
    device,
    /** прокрутка списка между показами экрана */
    scroll: { top: 0 },
    ready,
    mine,
    records,
    sessions,
    filters,
    pins,
    chips,
    selected,
    conditions,
    fitting,
    shown,
    projectOf,
    load,
    setView,
    pick,
    firstShow,
    /** список рисуется, когда настройки ответили; связи нет — встроенное без ожидания */
    drawn: () => ready() || app.link() !== "open",
    owner: facts.owner,
    toggle: (id: string, was: boolean) => setCollapsed({ [id]: !was }),
    current(c: { screen: string; params: Params }) {
      wanted = OF_SESSION.includes(c.screen) ? (c.params.callsign ?? null) : null;
      reveal();
    },
    link(state: Parameters<typeof own.onLink>[0], machine?: string) {
      void own.onLink(state, machine);
      void fleet.onLink(state, machine);
    },
    async stop() {
      await Promise.all([own.stop(), fleet.stop()]);
    },

    saveFilter(f: Filter) {
      own.edit<Filter[]>("filters", (old = []) => (old.some((x) => x.id === f.id) ? old.map((x) => (x.id === f.id ? f : x)) : [...old, f]));
      pick(f.id);
    },
    removeFilter(id: string) {
      own.edit<Filter[]>("filters", (old = []) => old.filter((f) => f.id !== id));
      pick("mine");
    },
    setRow: (ids: string[]) => own.edit<string[]>("row", () => ids),
    setPin(callsign: string, on: boolean) {
      own.edit<string[]>("pins", (old = []) => (on ? [...old, callsign] : old.filter((c) => c !== callsign)));
    },

    moveProject: (id: string, before?: string | null) => editFleet((r) => moveProject(r, id, before)),
    renameProject: (id: string, name: string) => editFleet((r) => renameProject(r, id, name)),
    addProject: (name: string) => editFleet((r) => addProject(r, name).recs),
    removeProject(id: string) {
      editFleet((r) => removeProject(r, id));
      if (filters().some((f) => f.projects?.includes(id))) own.edit<Filter[]>("filters", (old = []) => old.map((f) => (f.projects ? { ...f, projects: f.projects.filter((p) => p !== id) } : f)));
    },
    drop: (block: string[], project: string, before: string | null, rows: string[]) => editFleet((r) => dropSessions(r, block, project, before, rows)),
    assign: (callsign: string, project: string) => editFleet((r) => placeSessions(r, [callsign], project)),

    marks: {
      mine,
      "project.machines": (id: string) => [...new Set((sections().find((s) => s.id === id)?.callsigns ?? []).map((c) => machineOf(c)!))],
      "project.current": () => device.get().current,
      "project.of"(callsign: string) {
        const id = projectOf(callsign);
        const rec = records()?.find((r) => r.id === id);
        return id === NONE || !rec ? null : { id, name: rec.name };
      },
    },

    /** Поиск: по имени, адресу и проекту; срочные сверху. */
    find(q: string) {
      const name = (c: string) => records()?.find((r) => r.id === projectOf(c))?.name ?? "";
      const hits = sessions().filter((s) => [s.callsign, sessionLabel(app, s.callsign).text, name(s.callsign)].some((x) => x.toLowerCase().includes(q)));
      return byUrgency(hits).map((s) => ({
        label: sessionLabel(app, s.callsign).text,
        hint: `${machineLabel(app, machineOf(s.callsign)!).text} · папка ${folderOf(s.dir)}`,
        dot: lamp(s),
        screen: "card",
        params: { callsign: s.callsign },
      }));
    },
  };
}

export type BoardState = ReturnType<typeof createState>;
