// Модель «Работы»: чистые выборки из снимка модуля, roster и записей настроек. Ничего не меняет; состояние и действия — store.ts.
import type { App, SessionRecord } from "@switchboard/web-core";
import { failText, incidentOf, lamp, machineLabel, myAddress, profileNameOf, sessionLabel, stateLabel, type Personal, machinesWith } from "@switchboard/web-ui";
import { arrange, NONE, PROJECTS, projectIdOf, type ProjectRec } from "@switchboard/records";
import { kindOf, machineOf, userOf } from "@switchboard/protocol";
import type {} from "@switchboard/web-ask";
import type {} from "@switchboard/web-chat";
import type {} from "@switchboard/web-labels";
import { BUILT, firstOpen, match, orderFilters, parentOf, rank, tree, type Filter, type Project, type View } from "./rules.ts";

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

/** Что стоит в списке: строка сессии или лёгкая группа по машине. */
export type RowItem = { k: "row"; callsign: string; depth: number; noAt: boolean; project: string | null };
export type GroupItem = { k: "group"; machine: string; label: string; n: number };
export type Section = { id: string; name: string; open: boolean; lamps: Array<{ callsign: string; kind: string }>; grip: boolean; add: boolean; menu: boolean; items: Array<RowItem | GroupItem> };
export type ListModel = { flat: RowItem[] | null; sections: Section[]; empty: string };

const isMe = (a: unknown, mail: string | null) => !!mail && typeof a === "string" && userOf(a) === mail;

type Env = { app: App; user: Personal; fleet: Personal; state(): State };

export function createModel({ app, user, fleet, state }: Env) {
  const sessions = () => app.roster()?.sessions ?? [];
  const pins = () => user.get<string[]>("pins") ?? [];
  const recs = () => fleet.get<ProjectRec[]>(PROJECTS);
  const own = () => user.get<Filter[]>("filters") ?? [];
  const row = () => user.get<string[]>("row") ?? [];
  const session = (callsign: string) => sessions().find((x) => x.callsign === callsign);
  const projectId = (callsign: string) =>
    projectIdOf(recs(), callsign, (cs) => {
      const x = session(cs);
      return x ? parentOf(x) : null;
    });
  /** «Без проекта» — не проект: «последний проект» его не называет. */
  const realProject = (callsign: string) => {
    const id = projectId(callsign);
    return id === NONE ? null : id;
  };
  const projectName = (id: string) => recs()?.find((r) => r.id === id)?.name ?? (id === NONE ? "Без проекта" : id);

  const me = () => myAddress(app);
  /** Кто над сессией: открывшая её или давшая задачу сессия. */
  const upOf = (s: SessionRecord) => parentOf(s) ?? (typeof s.by === "string" && kindOf(s.by) === "session" && s.by !== s.callsign ? s.by : null);

  /** Почему сессия моя: задачу дали вы, открыли вы, открыла ваша сессия; не моя — "". */
  function whyMine(s: SessionRecord, mail = me(), depth = 0): string {
    if (pins().includes(s.callsign)) return "закреплена вами";
    if (isMe(s.by, mail)) return "задачу дали вы";
    if (isMe(s.parent, mail)) return "открыли вы";
    // открыла или дала задачу сессия — моя, если моя она
    const up = upOf(s);
    const ps = up ? session(up) : undefined;
    if (ps && depth < 8 && whyMine(ps, mail, depth + 1)) return `открыла ваша ${ps.callsign}`;
    return "";
  }

  /** Чья сессия: ~почта того, кто её завёл; завела сессия — её владелец. */
  function ownerOf(s: SessionRecord, depth = 0): string | null {
    for (const a of [s.by, s.parent]) if (typeof a === "string" && userOf(a)) return userOf(a);
    const up = upOf(s);
    const ps = up ? session(up) : undefined;
    return ps && depth < 8 ? ownerOf(ps, depth + 1) : null;
  }

  const sLabel = (callsign: string) => sessionLabel(app, callsign);
  const mLabel = (machine: string) => machineLabel(app, machine);
  const sName = (callsign: string) => sLabel(callsign).text;
  const mName = (machine: string) => mLabel(machine).text;

  const filters = () => orderFilters(own(), row());
  const currentFilter = () => filters().find((f) => f.id === state().flt) ?? BUILT[0];
  const fits = (f: Filter, s: SessionRecord, mail = me()) => match(f, s, projectId(s.callsign), (x) => !!whyMine(x, mail), (x) => ownerOf(x));

  /** Проекты выбранного фильтра в порядке записи. Совсем пустой проект виден всегда; проект, все сессии которого скрыты фильтром, скрыт. */
  function projects(): Project[] {
    const f = currentFilter();
    const mail = me();
    const links = sessions().map((s) => ({ callsign: s.callsign, parent: parentOf(s) }));
    return arrange(recs(), links).flatMap((sec): Project[] => {
      const ss = sec.callsigns.flatMap((cs) => session(cs) ?? []).filter((s) => fits(f, s, mail));
      if (!ss.length && sec.callsigns.length) return [];
      return [{ id: sec.id, name: sec.name, ss, r: Math.min(...ss.map(rank)) }];
    });
  }

  /** Вторая строка: вопрос, сообщение, причина сбоя или профиль и модель — что включено в виде. */
  function line(s: SessionRecord, asked: string | undefined): Array<{ c: string; t: string }> {
    const view = state().view;
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
    const asked = app.mark("asked", callsign);
    const unread = app.mark("unread", callsign);
    const machine = machineOf(callsign) ?? "";
    const owner = view.owner && !whyMine(s) ? ownerOf(s) : null;
    return {
      current: app.current()?.params.callsign === callsign,
      lamp: view.lamp ? lamp(s) : null,
      title: stateLabel(s.state).text,
      name: sName(callsign),
      human: sLabel(callsign).human,
      owner: owner ? owner.slice(1, owner.indexOf("@")) : null,
      inc: (view.inc ? incidentOf(s)?.type : undefined) ?? null,
      pin: view.pin && pins().includes(callsign),
      at: view.at && !noAt ? mName(machine) : null,
      atHuman: mLabel(machine).human,
      t2: [...(project ? [{ c: "prj", t: project }] : []), ...line(s, asked)],
      badge: !view.badge ? null : asked ? "?" : unread?.count || null,
    };
  }

  /** Строки проекта: деревом или ровно; лёгкие группы по машинам — если включены в виде. */
  function rowsOf(ss: SessionRecord[], noAt: boolean): RowItem[] {
    const ordered: Array<[SessionRecord, number]> = state().view.tree ? tree(ss) : ss.map((s) => [s, 0]);
    return ordered.map(([s, depth]) => ({ k: "row", callsign: s.callsign, depth, noAt, project: null }));
  }
  function projectRows(x: Project): Array<RowItem | GroupItem> {
    if (!state().view.group) return rowsOf(x.ss, false);
    const by = new Map<string, SessionRecord[]>();
    for (const s of x.ss) {
      const m = machineOf(s.callsign) ?? "";
      by.set(m, [...(by.get(m) ?? []), s]);
    }
    return [...by].sort((a, b) => a[0].localeCompare(b[0])).flatMap(([m, ss]): Array<RowItem | GroupItem> => [{ k: "group", machine: m, label: mName(m), n: ss.length }, ...rowsOf(ss, true)]);
  }

  /** Модель списка. Впервые увиденный проект — по правилу firstOpen; решение запоминает store. */
  function listModel(): ListModel {
    const { view, col, menuOf } = state();
    const ps = projects();
    const empty = `в «${currentFilter().name}» сессий нет`;
    // без группировки по проектам — плоский список в порядке проектов; проект — в строке
    if (!view.projects) return { flat: ps.flatMap((x) => x.ss.map((s): RowItem => ({ k: "row", callsign: s.callsign, depth: 0, noAt: false, project: x.name }))), sections: [], empty };
    const sections = ps.map((x): Section => {
      const open = col[x.id] === undefined ? firstOpen(x) : !col[x.id];
      return {
        id: x.id,
        name: x.name,
        open,
        // порядок ламп — единственное, что ещё зависит от состояния: «ждёт» и «сбой» первыми
        lamps: !open && view.pjlamps ? [...x.ss].sort((a, b) => rank(a) - rank(b)).slice(0, 6).map((s) => ({ callsign: s.callsign, kind: lamp(s) })) : [],
        grip: view.grip && x.id !== NONE,
        add: view.add,
        menu: menuOf === x.id,
        items: open ? projectRows(x) : [],
      };
    });
    return { flat: null, sections, empty };
  }

  /** Ряд фильтров: число — сколько сессий подходит. */
  function barModel() {
    const cur = currentFilter();
    const mail = me();
    const count = state().view.fcount;
    return filters().map((f) => ({ id: f.id, name: f.name, fixed: !!f.fixed, on: f.id === cur.id, n: count ? sessions().filter((s) => fits(f, s, mail)).length : null }));
  }

  /** Рисовать нельзя: первый рисунок ждёт ответа prefs (связи нет вовсе — рисуем встроенное); идёт перестановка. */
  function held() {
    return !app.roster() || ((!user.ready() || !fleet.ready()) && app.link() === "open") || state().reordering;
  }

  return {
    sessions,
    pins,
    recs,
    session,
    projectId,
    realProject,
    projectName,
    me,
    whyMine,
    ownerOf,
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
    projectOptions: () => [...(recs() ?? []).filter((r) => r.id !== NONE).map((r): [string, string] => [r.id, r.name]), [NONE, projectName(NONE)] as [string, string]],
    machines: () => machinesWith(app),
    owners: () => [...new Set(sessions().map((s) => ownerOf(s)).filter((x): x is string => !!x && x !== me()))].sort(),
  };
}
