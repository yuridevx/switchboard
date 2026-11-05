// Выборки «Работы»: что видно из снимка устройства, roster и записей настроек. Ничего не меняют.
import type { App, SessionRecord } from "@switchboard/web-core";
import { failText, incidentOf, lamp, machineLabel, machinesWith, myAddress, profileNameOf, sessionLabel, stateLabel, type Personal } from "@switchboard/web-ui";
import { arrange, NONE, PROJECTS, projectIdOf, type ProjectRec } from "@switchboard/records";
import { kindOf, machineOf, userOf } from "@switchboard/protocol";
import type {} from "@switchboard/web-ask";
import type {} from "@switchboard/web-chat";
import type {} from "@switchboard/web-labels";
import { BUILT, fits as fitsFilter, opensFirst, orderFilters, parentOf, rank, tree, type Filter, type View } from "./rules.ts";

/** Снимок модуля. */
export type State = {
  /** проект с открытым меню */
  menuOf: string | null;
  /** выбранный фильтр — выбор этого устройства */
  flt: string;
  /** свёрнутые проекты этого устройства; проекта нет — ещё не виден, решает первый показ */
  col: Record<string, boolean>;
  view: View;
  /** последний открытый проект — для экранов «Машины» и «Аккаунты» */
  lastProject: string | null;
  /** открытая сессия ждёт первого ответа prefs: её проект ещё неизвестен */
  follow: string | null;
  /** прокрутка списка: телефон строит экран заново при каждом возврате */
  bodyTop: number;
  /** идёт перестановка: жест меняет элементы списка напрямую, рисовать нельзя */
  reordering: boolean;
};

export type Project = { id: string; name: string; ss: SessionRecord[]; r: number };
export type RowItem = { k: "row"; callsign: string; depth: number; noAt: boolean; project: string | null };
export type GroupItem = { k: "group"; machine: string; label: string; n: number };
export type Section = { id: string; name: string; open: boolean; lamps: Array<{ callsign: string; kind: string }>; grip: boolean; add: boolean; menu: boolean; items: Array<RowItem | GroupItem> };
export type ListModel = { flat: RowItem[] | null; sections: Section[]; empty: string };

/** Глубина цепочки «кто открыл»: родители по кругу не зацикливают. */
const CHAIN = 8;

const isUser = (a: unknown, mail: string | null) => !!mail && typeof a === "string" && userOf(a) === mail;

export function createModel(app: App, user: Personal, fleet: Personal, state: () => State) {
  const sessions = () => app.roster()?.sessions ?? [];
  const session = (callsign: string) => sessions().find((x) => x.callsign === callsign);
  const pins = () => user.get<string[]>("pins") ?? [];
  const records = () => fleet.get<ProjectRec[]>(PROJECTS);
  const me = () => myAddress(app);

  const projectId = (callsign: string) =>
    projectIdOf(records(), callsign, (cs) => {
      const s = session(cs);
      return s ? parentOf(s) : null;
    });
  /** «Без проекта» — не проект: «последний проект» его не называет. */
  const realProject = (callsign: string) => {
    const id = projectId(callsign);
    return id === NONE ? null : id;
  };
  const projectName = (id: string) => records()?.find((r) => r.id === id)?.name ?? (id === NONE ? "Без проекта" : id);

  /** Кто над сессией: открывшая её или давшая задачу сессия. */
  const upper = (s: SessionRecord) => {
    const up = parentOf(s) ?? (typeof s.by === "string" && kindOf(s.by) === "session" && s.by !== s.callsign ? s.by : null);
    return up ? session(up) : undefined;
  };

  /** Почему сессия моя; не моя — "". */
  function whyMine(s: SessionRecord, mail = me(), depth = 0): string {
    if (pins().includes(s.callsign)) return "закреплена вами";
    if (isUser(s.by, mail)) return "задачу дали вы";
    if (isUser(s.parent, mail)) return "открыли вы";
    const up = upper(s);
    return up && depth < CHAIN && whyMine(up, mail, depth + 1) ? `открыла ваша ${up.callsign}` : "";
  }

  /** Чья сессия: ~почта того, кто её завёл; завела сессия — её владелец. */
  function ownerOf(s: SessionRecord, depth = 0): string | null {
    for (const a of [s.by, s.parent]) if (typeof a === "string" && userOf(a)) return userOf(a);
    const up = upper(s);
    return up && depth < CHAIN ? ownerOf(up, depth + 1) : null;
  }

  const sName = (callsign: string) => sessionLabel(app, callsign).text;
  const mName = (machine: string) => machineLabel(app, machine).text;

  const filters = () => orderFilters(user.get<Filter[]>("filters") ?? [], user.get<string[]>("row") ?? []);
  const currentFilter = () => filters().find((f) => f.id === state().flt) ?? BUILT[0];
  const fits = (f: Filter, s: SessionRecord, mail = me()) => fitsFilter(f, s, projectId(s.callsign), (x) => !!whyMine(x, mail), (x) => ownerOf(x));

  /** Проекты выбранного фильтра в порядке записи. Совсем пустой проект виден; проект, все сессии которого скрыты фильтром, скрыт. */
  function projects(): Project[] {
    const f = currentFilter();
    const mail = me();
    return arrange(records(), sessions().map((s) => ({ callsign: s.callsign, parent: parentOf(s) }))).flatMap((sec): Project[] => {
      const ss = sec.callsigns.flatMap((cs) => session(cs) ?? []).filter((s) => fits(f, s, mail));
      return !ss.length && sec.callsigns.length ? [] : [{ id: sec.id, name: sec.name, ss, r: Math.min(...ss.map(rank)) }];
    });
  }

  /** Вторая строка: вопрос, сообщение, причина сбоя или профиль и модель — что включено в виде. */
  function secondLine(s: SessionRecord): Array<{ c: string; t: string }> {
    const view = state().view;
    const asked = app.mark("asked", s.callsign);
    if (asked && view.q) return [{ c: "tx q", t: `? ${asked}` }];
    const unread = app.mark("unread", s.callsign);
    if (unread?.text && view.unread) return [{ c: "tx", t: unread.text }];
    if (s.state === "failed" && s.failed && view.fail) return [{ c: "tx f", t: failText(s) }];
    const prof = profileNameOf(s);
    return [...(prof && view.prof ? [{ c: "bd-pill", t: prof }] : []), ...(typeof s.model === "string" && s.model && view.model ? [{ c: "tx", t: s.model }] : [])];
  }

  /** Всё, что показывает строка: одна выборка на строку. */
  function rowData(callsign: string, noAt: boolean, project: string | null) {
    const s = session(callsign);
    if (!s) return null;
    const view = state().view;
    const machine = machineOf(callsign) ?? "";
    const label = sessionLabel(app, callsign);
    const host = machineLabel(app, machine);
    const owner = view.owner && !whyMine(s) ? ownerOf(s) : null;
    const unread = app.mark("unread", callsign);
    return {
      current: app.current()?.params.callsign === callsign,
      lamp: view.lamp ? lamp(s) : null,
      title: stateLabel(s.state).text,
      name: label.text,
      human: label.human,
      owner: owner ? owner.slice(1, owner.indexOf("@")) : null,
      inc: (view.inc ? incidentOf(s)?.type : undefined) ?? null,
      pin: view.pin && pins().includes(callsign),
      at: view.at && !noAt ? host.text : null,
      atHuman: host.human,
      t2: [...(project ? [{ c: "prj", t: project }] : []), ...secondLine(s)],
      badge: !view.badge ? null : app.mark("asked", callsign) ? "?" : unread?.count || null,
    };
  }

  /** Строки проекта: деревом или ровно. */
  function rowsOf(ss: SessionRecord[], noAt: boolean): RowItem[] {
    const ordered: Array<[SessionRecord, number]> = state().view.tree ? tree(ss) : ss.map((s) => [s, 0]);
    return ordered.map(([s, depth]) => ({ k: "row", callsign: s.callsign, depth, noAt, project: null }));
  }

  /** Строки проекта, с лёгкими группами по машинам, если они включены. */
  function projectRows(ss: SessionRecord[]): Array<RowItem | GroupItem> {
    if (!state().view.group) return rowsOf(ss, false);
    const machines = [...new Set(ss.map((s) => machineOf(s.callsign) ?? ""))].sort((a, b) => a.localeCompare(b));
    return machines.flatMap((m): Array<RowItem | GroupItem> => {
      const here = ss.filter((s) => (machineOf(s.callsign) ?? "") === m);
      return [{ k: "group", machine: m, label: mName(m), n: here.length }, ...rowsOf(here, true)];
    });
  }

  /** Модель списка. Впервые увиденный проект — по правилу первого показа; решение запоминает состояние. */
  function listModel(): ListModel {
    const { view, col, menuOf } = state();
    const ps = projects();
    const empty = `в «${currentFilter().name}» сессий нет`;
    // без группировки по проектам — плоский список в порядке проектов; проект — в строке
    if (!view.projects) return { flat: ps.flatMap((x) => x.ss.map((s): RowItem => ({ k: "row", callsign: s.callsign, depth: 0, noAt: false, project: x.name }))), sections: [], empty };
    const sections = ps.map((x): Section => {
      const open = col[x.id] === undefined ? opensFirst(x.r) : !col[x.id];
      return {
        id: x.id,
        name: x.name,
        open,
        // порядок ламп — единственное, что зависит от состояния: «ждёт» и «сбой» первыми
        lamps: !open && view.pjlamps ? [...x.ss].sort((a, b) => rank(a) - rank(b)).slice(0, 6).map((s) => ({ callsign: s.callsign, kind: lamp(s) })) : [],
        grip: view.grip && x.id !== NONE,
        add: view.add,
        menu: menuOf === x.id,
        items: open ? projectRows(x.ss) : [],
      };
    });
    return { flat: null, sections, empty };
  }

  /** Ряд фильтров: число — сколько сессий подходит. */
  function barModel() {
    const cur = currentFilter();
    const mail = me();
    return filters().map((f) => ({ id: f.id, name: f.name, fixed: !!f.fixed, on: f.id === cur.id, n: state().view.fcount ? sessions().filter((s) => fits(f, s, mail)).length : null }));
  }

  /** Рисовать нельзя: первый рисунок ждёт ответа prefs (связи нет вовсе — рисуем встроенное); идёт перестановка. */
  const held = () => !app.roster() || ((!user.ready() || !fleet.ready()) && app.link() === "open") || state().reordering;

  return {
    sessions,
    session,
    pins,
    projectId,
    realProject,
    projectName,
    whyMine,
    sName,
    mName,
    filters,
    fits,
    projects,
    rowData,
    listModel,
    barModel,
    held,
    /** Проекты для окна фильтра: номер и имя. */
    projectOptions: () => [...(records() ?? []).filter((r) => r.id !== NONE).map((r): [string, string] => [r.id, r.name]), [NONE, projectName(NONE)] as [string, string]],
    machines: () => machinesWith(app),
    owners: () => [...new Set(sessions().map((s) => ownerOf(s)).filter((x): x is string => !!x && x !== me()))].sort(),
  };
}
