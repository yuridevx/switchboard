// Состояние «Работы»: настройки у почты и флота, разделы устройства, правки. Всё остальное считается из roster.
import type { App, Params } from "@switchboard/web-ui";
import type { SessionRecord } from "@switchboard/web-core";
import { machineOf } from "@switchboard/protocol";
import { addProject, arrange, dropSessions, FLEET_PREFIX, moveProject, NONE, placeSessions, PROJECTS, projectIdOf, removeProject, renameProject, type ProjectRec } from "@switchboard/records";
import { createStore, folderOf, isWing, lamp, machineLabel, myAddress, personal, sessionLabel, wingOf } from "@switchboard/web-ui";
import { BUILT_IN, byUrgency, chipsOrder, matches, ownerOf, VIEW, whyMine, type Facts, type Filter, type Section, type View } from "./model.ts";

type Device = { flt: string; collapsed: Record<string, boolean>; view: View; current: string | null; picked: string | null };

export function createState(app: App) {
  const device = createStore<Device>({ flt: "mine", collapsed: {}, view: VIEW, current: null, picked: null }, () => app.changed());
  const changed = () => {
    reveal();
    app.changed();
  };
  const own = personal(app, "web-board", changed);
  const fleet = personal(app, FLEET_PREFIX, changed, "global");
  /** сессия открытого экрана ждёт ответа настроек */
  let wanted: string | null = null;

  /** все сессии флота: ведомый нужен, чтобы знать, чей он и где */
  const everyone = (): SessionRecord[] => app.roster()?.sessions ?? [];
  /** строки списка: пара — одна строка её ведущего */
  const sessions = () => everyone().filter((s) => !isWing(s));
  const records = () => fleet.get<ProjectRec[]>(PROJECTS);
  const filters = () => own.get<Filter[]>("filters") ?? [];
  const pins = () => own.get<string[]>("pins") ?? [];
  const parentOf = (callsign: string) => everyone().find((s) => s.callsign === callsign)?.parent as string | undefined;
  const projectOf = (callsign: string) => projectIdOf(records(), callsign, parentOf);
  const ready = () => own.ready() && fleet.ready();
  const mine = (callsign: string) => whyMine({ sessions: everyone(), me: myAddress(app), pins: pins() }, callsign);
  const facts: Facts = { mine: (c) => !!mine(c), owner: (c) => ownerOf(everyone(), c), project: projectOf };

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

  const needsYou = (callsigns: string[]) => everyone().some((s) => callsigns.includes(isWing(s) ? (s.parent as string) : s.callsign) && ["waiting", "failed"].includes(s.state as string));
  /** Свёрнут ли проект: как оставил человек; ещё не решено — по первому показу. */
  const folded = (id: string) => device.get().collapsed[id] ?? !needsYou(sections().find((s) => s.id === id)?.callsigns ?? []);

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
    const fresh = list.filter((s) => s.callsigns.length && device.get().collapsed[s.id] === undefined);
    if (fresh.length) setCollapsed(Object.fromEntries(fresh.map((s) => [s.id, folded(s.id)])));
  }

  async function load() {
    const [f, c, v, p] = await Promise.all([app.store<string>("flt").get(), app.store<Record<string, boolean>>("collapsed").get(), app.store<Partial<View>>("view").get(), app.store<string>("picked").get()]);
    device.set((d) => {
      d.flt = f ?? "mine";
      d.collapsed = c ?? {};
      d.view = { ...VIEW, ...v };
      d.picked = p ?? null;
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
    wingOf: (lead: string) => wingOf(everyone(), lead),
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
    folded,
    toggle: (id: string) => setCollapsed({ [id]: !folded(id) }),
    current(c: { params: Params }) {
      wanted = c.params.callsign ?? null;
      reveal();
      const open = c.params.callsign;
      if (open && open !== device.get().picked) {
        device.set((d) => void (d.picked = open));
        void app.store("picked").set(open);
      }
    },
    /** Вход на «Работу»: прежняя сессия, её нет — первая по выбранному отбору. */
    entry(): string | null {
      if (!ready()) return null;
      const was = device.get().picked;
      if (was && sessions().some((x) => x.callsign === was)) return was;
      return shown(conditions(selected())).flatMap((x) => x.callsigns)[0] ?? null;
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
      own.edit<string[]>("pins", (old = []) => [...old.filter((c) => c !== callsign), ...(on ? [callsign] : [])]);
    },

    moveProject: (id: string, before?: string | null) => editFleet((r) => moveProject(r, id, before)),
    renameProject: (id: string, name: string) => editFleet((r) => renameProject(r, id, name)),
    addProject: (name: string) => editFleet((r) => addProject(r, name).recs),
    removeProject(id: string) {
      editFleet((r) => removeProject(r, id));
      own.edit<Filter[]>("filters", (old = []) => old.map((f) => (f.projects?.includes(id) ? { ...f, projects: f.projects.filter((p) => p !== id) } : f)));
    },
    /** Бросок: строки проекта — под фильтром, и на свёрнутом их не видно. */
    drop(block: string[], project: string, before: string | null) {
      const rows = shown(conditions(selected())).find((s) => s.id === project)?.callsigns ?? [];
      editFleet((r) => dropSessions(r, block, project, before, rows));
    },
    /** Место новой сессии у проекта: его верхняя сессия, если её машина открывает сессии. */
    placeOf(id: string): Record<string, string> {
      const top = sessions().find((s) => s.callsign === sections().find((x) => x.id === id)?.callsigns[0]);
      const machine = top && machineOf(top.callsign);
      return { ...(machine && app.can(machine, "session.open") ? { machine, dir: String(top.dir ?? "~") } : {}), ...(id === NONE ? {} : { project: id }) };
    },
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
      const project = (c: string) => sections().find((x) => x.callsigns.includes(c))?.name ?? "";
      const hits = sessions().filter((s) => [s.callsign, sessionLabel(app, s.callsign).text, folderOf(s.dir), project(s.callsign)].some((x) => x.toLowerCase().includes(q)));
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
