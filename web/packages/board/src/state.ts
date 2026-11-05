// Стор «Работы»: настройки почты и флота, разделы устройства и снимок списка. Экран рисует снимок, правит через действия.
import { machineOf } from "@switchboard/protocol";
import { addProject, arrange, dropSessions, FLEET_PREFIX, moveProject, NONE, placeSessions, projectIdOf, PROJECTS, removeProject, renameProject, type ProjectRec } from "@switchboard/records";
import { createStore, folderOf, incidentOf, lamp, failText, machineLabel, myAddress, personal, profileNameOf, sessionLabel, sessionOf, stateLabel, type App, type ConnState } from "@switchboard/web-ui";
import { ALL, byUrgency, chipOrder, DEFAULT_VIEW, fits, MINE, ownerOf, placeRows, whyMine, type Filter, type View } from "./model.ts";

type Shown = { text: string; human: boolean };
export type RowModel = {
  callsign: string;
  depth: number;
  dot: string;
  title: string;
  name: Shown;
  at: Shown | null;
  own: string;
  pinned: boolean;
  inc: string;
  project: string;
  /** вторая строка: одно из вопрос, сбой, непрочитанное; иначе профиль и модель */
  line: { kind: "q" | "f" | "u" | ""; text: string };
  prof: string;
  model: string;
  badge: { wait: boolean; text: string } | null;
};
export type SectionModel = { id: string; name: string; collapsed: boolean; lamps: string[]; groups: Array<{ machine: string; label: string; rows: RowModel[] }> | null; rows: RowModel[]; live: boolean };
export type Chip = { id: string; name: string; count: number; own: boolean };

/** Ламп у свёрнутого проекта: больше не помещается. */
const LAMPS = 6;

export type BoardState = ReturnType<typeof createBoardState>;

export function createBoardState(app: App) {
  /** первый показ и открытая сессия ждут настройки: их ответ — повод решить заново */
  const changed = () => {
    settle();
    app.changed();
  };
  const user = personal(app, "web-board", changed);
  const fleet = personal(app, FLEET_PREFIX, changed, "global");
  // разделы хранилища доступны, когда модуль уже определён
  const flt = () => app.store<string>("flt");
  const collapsedPart = () => app.store<Record<string, boolean>>("collapsed");
  const viewPart = () => app.store<View>("view");
  const local = createStore({ flt: MINE, collapsed: {} as Record<string, boolean>, view: DEFAULT_VIEW, last: null as string | null }, app.changed);
  /** сессия, чей проект надо открыть, когда придут настройки */
  let opening: string | null = null;
  /** идёт жест: список не перерисовывается */
  let gesture = false;

  const recs = () => fleet.get<ProjectRec[]>(PROJECTS);
  const filters = () => user.get<Filter[]>("filters") ?? [];
  const pins = () => user.get<string[]>("pins") ?? [];
  const sessions = () => app.roster()?.sessions ?? [];
  const find = (cs: string) => sessionOf(app, cs);
  const parentOf = (cs: string) => find(cs)?.parent;
  const ready = () => user.ready() && fleet.ready();
  const mine = (cs: string) => whyMine(cs, { find, me: myAddress(app), pins: pins() });
  const sectionsOf = () => arrange(recs(), sessions().map((s) => ({ callsign: s.callsign, parent: typeof s.parent === "string" ? s.parent : null })));
  const projectOf = (cs: string) => projectIdOf(recs(), cs, (c) => parentOf(c) as string | null | undefined);
  const needsYou = (callsigns: string[]) => callsigns.some((cs) => ["waiting", "failed"].includes(String(find(cs)?.state)));
  const isCollapsed = (id: string, callsigns: string[]) => local.get().collapsed[id] ?? !needsYou(callsigns);

  function writeCollapsed(change: (c: Record<string, boolean>) => void) {
    local.set((s) => change(s.collapsed));
    void collapsedPart().set(local.get().collapsed);
  }

  /** Открытая сессия и первый показ проектов: решается, когда настройки ответили. */
  function settle() {
    if (!ready()) return;
    if (opening) {
      const id = projectOf(opening);
      opening = null;
      local.set((s) => void (s.last = id === NONE ? null : id));
      if (local.get().collapsed[id] !== false) writeCollapsed((c) => void (c[id] = false));
    }
    const at = app.current();
    if (!local.get().view.projects || (at?.screen !== "board" && at?.master !== "board")) return;
    // решается только о видимых сейчас: скрытые фильтром проекты решат свой первый показ сами
    const fit = fitsChip(chosenChip());
    const fresh = sectionsOf().filter((x) => x.callsigns.some(fit) && local.get().collapsed[x.id] === undefined);
    if (fresh.length) writeCollapsed((c) => fresh.forEach((x) => (c[x.id] = !needsYou(x.callsigns))));
  }

  const chosenChip = () => {
    const id = local.get().flt;
    return chipOrder(filters(), user.get<string[]>("row")).includes(id) ? id : MINE;
  };
  const traits = (cs: string) => ({ mine: !!mine(cs), owner: ownerOf(cs, find), project: projectOf(cs) });
  const fitsChip = (id: string) => (cs: string) => {
    if (id === ALL) return true;
    if (id === MINE) return !!mine(cs);
    const f = filters().find((x) => x.id === id);
    return !!f && fits(f, find(cs)!, traits(cs));
  };

  function rowOf(cs: string, depth: number, view: View, o: { at: boolean; project: string }): RowModel {
    const s = find(cs)!;
    const owner = ownerOf(cs, find);
    const unread = app.mark("unread", cs) as { count: number; text: string } | undefined;
    const asked = app.mark("asked", cs) as string | undefined;
    const failed = failText(s);
    const incident = incidentOf(s);
    const line: RowModel["line"] = view.q && asked ? { kind: "q", text: `? ${asked}` } : view.fail && failed ? { kind: "f", text: failed } : view.unread && unread?.count ? { kind: "u", text: unread.text } : { kind: "", text: "" };
    return {
      callsign: cs,
      depth,
      dot: view.lamp ? lamp(s) : "",
      title: stateLabel(s.state).text,
      name: sessionLabel(app, cs),
      at: o.at ? machineLabel(app, machineOf(cs) ?? "") : null,
      own: view.owner && owner && !mine(cs) ? owner.slice(1).split("@")[0] : "",
      pinned: view.pin && pins().includes(cs),
      inc: view.inc && incident?.type ? incident.type : "",
      project: o.project,
      line,
      prof: view.prof ? (profileNameOf(s) ?? "") : "",
      model: view.model && typeof s.model === "string" ? s.model : "",
      badge: !view.badge ? null : asked ? { wait: true, text: "?" } : unread?.count ? { wait: false, text: String(unread.count) } : null,
    };
  }

  /** Что показать сейчас. */
  function model() {
    const { view } = local.get();
    const all = sessions().map((s) => s.callsign);
    const ids = chipOrder(filters(), user.get<string[]>("row"));
    const nameOf = (id: string) => (id === MINE ? "Моё" : id === ALL ? "Всё" : (filters().find((f) => f.id === id)?.name ?? id));
    const chips: Chip[] = ids.map((id) => ({ id, name: nameOf(id), count: view.fcount ? all.filter(fitsChip(id)).length : 0, own: id !== MINE && id !== ALL }));
    const selected = chosenChip();
    const fit = fitsChip(selected);
    const grouped = view.projects && view.group;
    const sections: SectionModel[] = sectionsOf().flatMap(({ id, name, callsigns }) => {
      const shown = callsigns.filter(fit);
      if (callsigns.length && !shown.length) return [];
      const collapsed = isCollapsed(id, callsigns);
      const place = (list: string[]) => placeRows(list, parentOf, view.tree).map((x) => rowOf(x.callsign, x.depth, view, { at: view.at && !grouped, project: "" }));
      const machines = [...new Set(shown.map((cs) => machineOf(cs) ?? ""))].sort();
      const lamps = collapsed && view.pjlamps ? byUrgency(shown.map((cs) => find(cs)!)).slice(0, LAMPS).map(lamp) : [];
      // дочерняя под родителем — только в его группе
      const groups = grouped && !collapsed ? machines.map((machine) => ({ machine, label: machineLabel(app, machine).text, rows: place(shown.filter((cs) => machineOf(cs) === machine)) })) : null;
      const rows = groups ? groups.flatMap((g) => g.rows) : collapsed ? [] : place(shown);
      return [{ id, name, collapsed, lamps, groups, rows, live: callsigns.length > 0 }];
    });
    const flat = view.projects ? [] : sectionsOf().flatMap(({ name, callsigns }) => callsigns.filter(fit).map((cs) => rowOf(cs, 0, view, { at: view.at, project: name })));
    return { drawn: ready() || app.link() !== "open", view, chips, selected, selectedName: nameOf(selected), sections, flat, order: sections.map((x) => x.id) };
  }

  /** Значения полей окна фильтра. */
  function options() {
    const list = sessions();
    const owners = [...new Set(list.map((s) => ownerOf(s.callsign, find)).filter((x): x is string => !!x && x !== myAddress(app)))].sort();
    return {
      who: owners,
      projects: sectionsOf().map((x) => ({ id: x.id, name: x.name })),
      machines: (app.roster()?.machines ?? []).map((m) => m.machine).sort().map((m) => ({ id: m, name: machineLabel(app, m).text })),
      profiles: [...new Set(list.map(profileNameOf).filter((x): x is string => !!x))].sort(),
    };
  }

  /** Сколько сессий и проектов подойдёт под черновик фильтра. */
  function matching(f: Filter) {
    const hit = sessions().filter((s) => fits(f, s, traits(s.callsign)));
    return { sessions: hit.length, projects: new Set(hit.map((s) => projectOf(s.callsign))).size };
  }

  const editProjects = (fn: (old: ProjectRec[] | undefined) => ProjectRec[]) => fleet.edit<ProjectRec[]>(PROJECTS, fn);

  return {
    model,
    options,
    matching,
    /** выборка списка во время жеста отдаёт прошлый ответ */
    held: () => gesture,
    hold(on: boolean) {
      gesture = on;
      if (!on) app.changed();
    },
    mine,
    canPin: (cs: string) => !!find(cs) && !mine(cs),
    start: async () => {
      const [f, c, v] = await Promise.all([flt().get(), collapsedPart().get(), viewPart().get()]);
      local.set((s) => {
        s.flt = f ?? MINE;
        s.collapsed = c ?? {};
        s.view = { ...DEFAULT_VIEW, ...v };
      });
    },
    onCurrent(c: { params: Record<string, string> }) {
      opening = c.params.callsign ?? null;
      settle();
    },
    onRoster: settle,
    onLink(state: ConnState, machine?: string) {
      void user.onLink(state, machine);
      void fleet.onLink(state, machine);
    },
    stop: async () => {
      await Promise.all([user.stop(), fleet.stop()]);
    },
    current: () => local.get().last,
    projectMachines: (id: string) => [...new Set((sectionsOf().find((x) => x.id === id)?.callsigns ?? []).map((cs) => machineOf(cs) ?? ""))],
    projectOf(cs: string) {
      const id = projectOf(cs);
      return id === NONE ? null : { id, name: recs()?.find((r) => r.id === id)?.name ?? id };
    },
    /** Строки поиска Ctrl K. */
    find(q: string) {
      return byUrgency(sessions()).flatMap((s) => {
        const name = sessionLabel(app, s.callsign).text;
        const folder = folderOf(s.dir);
        const project = sectionsOf().find((x) => x.callsigns.includes(s.callsign))?.name ?? "";
        if (![name, s.callsign, folder, project].some((x) => x.toLowerCase().includes(q))) return [];
        return [{ label: name, hint: `${machineLabel(app, machineOf(s.callsign) ?? "").text} · папка ${folder}`, dot: lamp(s), screen: "card", params: { callsign: s.callsign } }];
      });
    },
    choose(id: string) {
      local.set((s) => void (s.flt = id));
      void flt().set(id);
      settle();
    },
    toggle(id: string) {
      const callsigns = sectionsOf().find((x) => x.id === id)?.callsigns ?? [];
      writeCollapsed((c) => void (c[id] = !isCollapsed(id, callsigns)));
    },
    /** Новая сессия у проекта: место его верхней сессии и номер. */
    placeOf(id: string): Record<string, string> {
      const top = find(sectionsOf().find((x) => x.id === id)?.callsigns[0] ?? "");
      const machine = top ? machineOf(top.callsign) : null;
      const able = machine && app.can(machine, "session.open");
      return { ...(able ? { machine, dir: String(top!.dir ?? "~") } : {}), ...(id === NONE ? {} : { project: id }) };
    },
    /** прокрутка списка: возврат к нему на том же месте */
    scroll: { top: 0 },
    setView(key: string, on: boolean) {
      local.set((s) => void (s.view[key] = on));
      void viewPart().set(local.get().view);
    },
    resetView() {
      local.set((s) => void (s.view = DEFAULT_VIEW));
      void viewPart().set(DEFAULT_VIEW);
    },
    saveFilter(f: Filter) {
      user.edit<Filter[]>("filters", (old = []) => (old.some((x) => x.id === f.id) ? old.map((x) => (x.id === f.id ? f : x)) : [...old, f]));
    },
    removeFilter(id: string) {
      user.edit<Filter[]>("filters", (old = []) => old.filter((x) => x.id !== id));
      if (local.get().flt === id) this.choose(MINE);
    },
    filterOf: (id: string) => filters().find((f) => f.id === id),
    setRow: (row: string[]) => user.edit<string[]>("row", () => row),
    setPinned(cs: string, on: boolean) {
      user.edit<string[]>("pins", (old = []) => (on ? [...old.filter((x) => x !== cs), cs] : old.filter((x) => x !== cs)));
    },
    isPinned: (cs: string) => pins().includes(cs),
    moveProject: (id: string, before: string | null) => editProjects((old) => moveProject(old, id, before)),
    addProject: (name: string) => editProjects((old) => addProject(old, name).recs),
    renameProject: (id: string, name: string) => editProjects((old) => renameProject(old, id, name)),
    removeProject(id: string) {
      editProjects((old) => removeProject(old, id));
      user.edit<Filter[]>("filters", (old = []) => old.map((f) => (f.projects?.includes(id) ? { ...f, projects: f.projects.filter((p) => p !== id) } : f)));
    },
    assign: (callsign: string, id: string) => editProjects((old) => placeSessions(old, [callsign], id)),
    dropRows: (block: string[], id: string, before: string | null, shown: string[]) => editProjects((old) => dropSessions(old, block, id, before, shown)),
    /** Строки проекта на экране: при броске на свёрнутый их не видно. */
    shownIn: (id: string) => sectionsOf().find((x) => x.id === id)?.callsigns.filter(fitsChip(local.get().flt)) ?? [],
  };
}
