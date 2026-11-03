// web-board — «Работа»: сессии всех машин по проектам в одном списке для колонки пульта и экрана телефона. Проект — последнее имя папки
// (правило projectOf набора). Настройки человека — у его почты (Worker prefs, ключи web-board.*): свои фильтры, порядок фильтров, закреплённые
// проекты и сессии; одни на всех его устройствах. Настройки устройства — в хранилище страницы: выбранный фильтр, свёрнутые проекты, вид списка.
// «Моё» — сессия, ввод или открытие которой пришли от моего адреса (имя~почта), её дочери и закреплённые; метка mine — одно место этого правила.
// Вид: список и ряд фильтров читают модель выборкой, строка — свою выборкой: на изменение одной сессии перерисовывается одна строка.
// Пока идёт перестановка, выборки держат прошлый ответ; её конец рисует ряд и список заново: жест менял их элементы напрямую.
import { memo, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { App, AppModule, SessionRecord } from "@switchboard/web-core";
import { Badge, Btn, Dot, myAddress, personal, projectOf, stateLabel, type Personal } from "@switchboard/web-ui";
import { kindOf, machineOf, userOf } from "@switchboard/protocol";
import type {} from "@switchboard/web-ask";
import type {} from "@switchboard/web-chat";
import type {} from "@switchboard/web-labels";
import css from "./board.css";
import { attachChipDrag } from "./chips-drag.ts";
import { FilterEditor } from "./filters.tsx";
import { attachProjectDrag } from "./projects-drag.ts";
import { BUILT, byRank, incidentOf, match, orderFilters, orderProjects, parentOf, placeTop, profileOf, rank, tree, type Filter, type Project } from "./rules.ts";
import { VIEW0, ViewPanel, type View } from "./view.tsx";

const lamp = (s: SessionRecord) => (s.state === "failed" ? "bad" : stateLabel(s.state).dot || "stop");

/** Ответ выборки, пока список рисовать нельзя: компонент оставляет прошлый. */
const HOLD = Symbol("hold");

/** Что стоит в списке: строка сессии или лёгкая группа по машине. */
type RowItem = { k: "row"; callsign: string; depth: number; noAt: boolean; project: string | null };
type GroupItem = { k: "group"; machine: string; label: string; n: number };
type Section = { name: string; pinned: boolean; sep: boolean; open: boolean; count: number | null; lamps: string[]; grip: boolean; add: boolean; items: Array<RowItem | GroupItem> };
type ListModel = { flat: RowItem[] | null; sections: Section[]; empty: string; current: string | undefined };

/** Новый модуль со своей памятью (в выпуске — один; в тестах — на каждый прогон). */
export function createBoard(): AppModule {
  let app: App;
  let p: Personal;
  /** выбранный фильтр — выбор этого устройства */
  let flt = "mine";
  /** свёрнутые проекты этого устройства; проекта нет — ещё не виден, решает первый показ */
  let col: Record<string, boolean> = {};
  let view: View = { ...VIEW0 };
  /** последний открытый проект — для экранов «Машины» и «Аккаунты» */
  let lastProject: string | null = null;
  let lastCurrent: string | undefined;
  /** прокрутка списка: телефон строит экран заново при каждом возврате */
  let bodyTop = 0;
  /** постоянный элемент списка: на нём класс перестановки */
  let listNode: HTMLElement | null = null;
  /** сессия, которую список покажет после рисунка */
  let follow: string | null = null;

  const sessions = () => app?.roster()?.sessions ?? [];
  const pins = () => p?.get<string[]>("pins") ?? [];
  const top = () => p?.get<string[]>("top") ?? [];
  const own = () => p?.get<Filter[]>("filters") ?? [];
  const row = () => p?.get<string[]>("row") ?? [];
  const session = (callsign: string) => sessions().find((x) => x.callsign === callsign);

  const me = () => (app ? myAddress(app) : null);
  const isMe = (a: unknown, mail: string | null) => !!mail && typeof a === "string" && userOf(a) === mail;

  /** Почему сессия моя: задачу дали вы, открыли вы, открыла ваша сессия; не моя — "". */
  function whyMine(s: SessionRecord, mail = me(), depth = 0): string {
    if (pins().includes(s.callsign)) return "закреплена вами";
    if (isMe(s.by, mail)) return "задачу дали вы";
    if (isMe(s.parent, mail)) return "открыли вы";
    // открыла или дала задачу сессия — моя, если моя она
    const sender = typeof s.by === "string" && kindOf(s.by) === "session" && s.by !== s.callsign ? s.by : null;
    const up = parentOf(s) ?? sender;
    const ps = up ? session(up) : undefined;
    if (ps && depth < 8 && whyMine(ps, mail, depth + 1)) return `открыла ваша ${ps.callsign}`;
    return "";
  }

  /** Чья сессия: ~почта того, кто её завёл; завела сессия — её владелец. */
  function ownerOf(s: SessionRecord, depth = 0): string | null {
    for (const a of [s.by, s.parent]) if (typeof a === "string" && userOf(a)) return userOf(a);
    const up = parentOf(s) ?? (typeof s.by === "string" && kindOf(s.by) === "session" && s.by !== s.callsign ? s.by : null);
    const ps = up ? session(up) : undefined;
    return ps && depth < 8 ? ownerOf(ps, depth + 1) : null;
  }

  const sLabel = (callsign: string) => app.mark("label.session", callsign);
  const mLabel = (machine: string) => app.mark("label.machine", machine);
  const sName = (callsign: string) => sLabel(callsign)?.text ?? callsign;
  const mName = (machine: string) => mLabel(machine)?.text ?? `@${machine}`;

  const filters = () => orderFilters(own(), row());
  const currentFilter = () => filters().find((f) => f.id === flt) ?? BUILT[0];
  const fits = (f: Filter, s: SessionRecord, mail = me()) => match(f, s, projectOf(s.dir), (x) => !!whyMine(x, mail), (x) => ownerOf(x));

  /** Проекты выбранного фильтра в порядке списка. */
  function projects(): Project[] {
    const f = currentFilter();
    const mail = me();
    const g = new Map<string, SessionRecord[]>();
    for (const s of sessions()) {
      if (!fits(f, s, mail)) continue;
      const name = projectOf(s.dir);
      g.set(name, [...(g.get(name) ?? []), s]);
    }
    return orderProjects([...g].map(([name, ss]) => ({ name, ss, r: Math.min(...ss.map(rank)) })), top());
  }

  /** Вторая строка: вопрос, сообщение, причина сбоя или профиль и модель — что включено в виде. */
  function line(s: SessionRecord, asked: string | undefined): Array<{ c: string; t: string }> {
    if (asked && view.q) return [{ c: "tx q", t: `? ${asked}` }];
    const unread = app.mark("unread", s.callsign);
    if (unread?.text && view.unread) return [{ c: "tx", t: unread.text }];
    if (s.state === "failed" && s.failed && view.fail) return [{ c: "tx f", t: Object.values(s.failed as Record<string, string>).join("; ") }];
    const prof = profileOf(s);
    return [...(prof && view.prof ? [{ c: "bd-pill", t: prof }] : []), ...(typeof s.model === "string" && s.model && view.model ? [{ c: "tx", t: s.model }] : [])];
  }

  function openSession(s: SessionRecord) {
    lastProject = projectOf(s.dir);
    // телефон: сессия с вопросом — сразу вопрос; пульт — карточка, вопрос в разговоре
    if (!app.wide && app.mark("asked", s.callsign)) app.open("ask", { callsign: s.callsign });
    else app.open("card", { callsign: s.callsign });
  }

  /** Всё, что показывает строка: одна выборка на строку. */
  function rowData(callsign: string, noAt: boolean, project: string | null) {
    const s = session(callsign);
    if (!s) return null;
    const asked = app.mark("asked", callsign);
    const unread = app.mark("unread", callsign);
    const machine = machineOf(callsign) ?? "";
    const owner = view.owner && !whyMine(s) ? ownerOf(s) : null;
    return {
      current: app.current()?.params.callsign === callsign,
      lamp: view.lamp ? lamp(s) : null,
      title: stateLabel(s.state).text,
      name: sName(callsign),
      human: !!sLabel(callsign)?.human,
      owner: owner ? owner.slice(1, owner.indexOf("@")) : null,
      inc: (view.inc ? incidentOf(s) : undefined) ?? null,
      pin: view.pin && pins().includes(callsign),
      at: view.at && !noAt ? mName(machine) : null,
      atHuman: !!mLabel(machine)?.human,
      t2: [...(project ? [{ c: "prj", t: project }] : []), ...line(s, asked)],
      badge: !view.badge ? null : asked ? "?" : unread?.count || null,
    };
  }

  /** Строки проекта: деревом или ровно; лёгкие группы по машинам — если включены в виде. */
  function rowsOf(ss: SessionRecord[], noAt: boolean): RowItem[] {
    const ordered: Array<[SessionRecord, number]> = view.tree ? tree(ss) : [...ss].sort(byRank).map((s) => [s, 0]);
    return ordered.map(([s, depth]) => ({ k: "row", callsign: s.callsign, depth, noAt, project: null }));
  }
  function projectRows(x: Project): Array<RowItem | GroupItem> {
    if (!view.group) return rowsOf(x.ss, false);
    const by = new Map<string, SessionRecord[]>();
    for (const s of x.ss) {
      const m = machineOf(s.callsign) ?? "";
      by.set(m, [...(by.get(m) ?? []), s]);
    }
    return [...by]
      .sort((a, b) => Math.min(...a[1].map(rank)) - Math.min(...b[1].map(rank)) || a[0].localeCompare(b[0]))
      .flatMap(([m, ss]): Array<RowItem | GroupItem> => [{ k: "group", machine: m, label: mName(m), n: ss.length }, ...rowsOf(ss, true)]);
  }

  /** «+» у проекта — место его верхней сессии, чья машина на связи. */
  function newIn(name: string) {
    const x = projects().find((y) => y.name === name);
    const online = new Set((app.roster()?.machines ?? []).filter((m) => m.contract?.["session.open"] !== undefined).map((m) => m.machine));
    const s = x && tree(x.ss).map(([y]) => y).find((y) => online.has(machineOf(y.callsign) ?? "") && typeof y.dir === "string");
    app.open("open", s ? { machine: machineOf(s.callsign)!, dir: s.dir as string } : {});
  }

  function saveCol() {
    void app.store<Record<string, boolean>>("collapsed").set(col);
  }

  /** Найденная или только что открытая сессия видна: её проект разворачивается, список её показывает. */
  function followCurrent() {
    const callsign = app.current()?.params.callsign;
    if (callsign === lastCurrent) return;
    lastCurrent = callsign;
    const s = callsign ? session(callsign) : undefined;
    if (!s) return;
    const name = projectOf(s.dir);
    lastProject = name;
    follow = s.callsign;
    if (col[name] !== false) {
      col[name] = false;
      saveCol();
    }
  }

  /** Модель списка. Первый показ проекта и переход к открытой сессии решаются здесь: повтор при том же ответе ничего не меняет. */
  function listModel(): ListModel {
    followCurrent();
    const ps = projects();
    const empty = `в «${currentFilter().name}» сессий нет`;
    // без группировки по проектам — плоский список: ждут вас, работают, по имени; проект — в строке
    if (!view.projects) {
      const flat = ps.flatMap((x) => x.ss).sort(byRank);
      return { flat: flat.map((s) => ({ k: "row", callsign: s.callsign, depth: 0, noAt: false, project: projectOf(s.dir) })), sections: [], empty, current: lastCurrent };
    }
    let seen = false;
    let sep = false;
    const sections = ps.map((x): Section => {
      // впервые увиденный проект развёрнут, только если в нём ждут вас или сбой; дальше — как оставил человек
      if (col[x.name] === undefined) {
        col[x.name] = x.r !== 0;
        seen = true;
      }
      const open = !col[x.name];
      const pinned = top().includes(x.name);
      // граница закреплённых и остальных — тонкая черта
      const line = !pinned && !sep && ps.some((y) => top().includes(y.name));
      if (line) sep = true;
      return {
        name: x.name,
        pinned,
        sep: line,
        open,
        count: view.pjcount ? x.ss.length : null,
        lamps: !open && view.pjlamps ? x.ss.slice(0, 6).map(lamp) : [],
        grip: view.grip,
        add: view.add,
        items: open ? projectRows(x) : [],
      };
    });
    if (seen) saveCol();
    return { flat: null, sections, empty, current: lastCurrent };
  }

  /** Ряд фильтров: число — сколько сессий подходит. */
  function barModel() {
    const cur = currentFilter();
    const mail = me();
    return filters().map((f) => ({ id: f.id, name: f.name, fixed: !!f.fixed, on: f.id === cur.id, n: view.fcount ? sessions().filter((s) => fits(f, s, mail)).length : null }));
  }

  /** Рисовать нельзя: первый рисунок ждёт ответа prefs (связи нет вовсе — рисуем встроенное); идёт перестановка. */
  const held = () => !app.roster() || (!p.ready() && app.link() === "open") || !!listNode?.classList.contains("reordering");

  /** Выборка вида: пока рисовать нельзя — прошлый ответ. */
  function useHeld<T>(select: () => T): T | undefined {
    const last = useRef<T | undefined>(undefined);
    const v = app.use<T | typeof HOLD>(() => (held() ? HOLD : select()));
    if (v !== HOLD) last.current = v as T;
    return last.current;
  }

  const Row = memo(function Row({ callsign, depth, noAt, project }: Omit<RowItem, "k">) {
    const d = useHeld(() => rowData(callsign, noAt, project));
    if (!d) return null;
    return (
      <button
        className={"bd-row" + (depth ? " kid" : "")}
        data-callsign={callsign}
        aria-current={d.current ? "true" : "false"}
        style={depth ? { paddingLeft: `${10 + depth * 22}px` } : undefined}
        onClick={() => {
          const s = session(callsign);
          if (s) openSession(s);
        }}
      >
        {d.lamp ? <Dot kind={d.lamp} title={d.title} /> : null}
        <span className="bd-rt">
          <span className="bd-t1">
            <b className={"bd-cs" + (d.human ? " hum" : "")}>{d.name}</b>
            {d.owner ? <span className="bd-pill own">{d.owner}</span> : null}
            {d.inc ? <span className="bd-pill inc">{d.inc}</span> : null}
            {d.pin ? (
              <svg className="bd-pin" viewBox="0 0 16 16" role="img" aria-label="закреплена">
                <path d="M6 2h4l-.5 4 2.5 2.5V10H8.6L8 14l-.6-4H4V8.5L6.5 6z" />
              </svg>
            ) : null}
            {d.at !== null ? <span className={"bd-at" + (d.atHuman ? " hum" : "")}>{d.at}</span> : null}
          </span>
          {d.t2.length ? (
            <span className="bd-t2">
              {d.t2.map((x) => (
                <span key={x.c} className={x.c}>
                  {x.t}
                </span>
              ))}
            </span>
          ) : null}
        </span>
        {d.badge === "?" ? (
          <Badge wait aria-label="ждёт ответа">
            ?
          </Badge>
        ) : d.badge ? (
          <Badge>{d.badge}</Badge>
        ) : null}
      </button>
    );
  });

  const ProjectSection = memo(function ProjectSection({ x }: { x: Section }) {
    return (
      <section className={"pjs" + (x.pinned ? " pinned" : "")} data-proj={x.name}>
        <div className="pj">
          {x.grip ? (
            <span className="grip" role="button" tabIndex={0} data-proj={x.name} aria-label={`Переместить ${x.name}: перетащить или стрелки`}>
              ⠿
            </span>
          ) : null}
          <button
            className="pj-t"
            aria-expanded={x.open}
            data-proj={x.name}
            onClick={() => {
              col[x.name] = !col[x.name];
              saveCol();
              app.changed();
            }}
          >
            <span className="car">▼</span>
            <span className="nm">{x.name}</span>
            <span className="lamps">
              {x.lamps.map((l, i) => (
                <Dot key={i} kind={l} />
              ))}
              {x.count !== null ? <span className="n">{String(x.count)}</span> : null}
            </span>
          </button>
          {x.add ? (
            <button className="pj-add" data-proj={x.name} aria-label={`Новая сессия в ${x.name}`} onClick={() => newIn(x.name)}>
              +
            </button>
          ) : null}
        </div>
        {x.items.map((it) =>
          it.k === "group" ? (
            <div key={`g:${it.machine}`} className="mgrp" data-group={it.machine}>
              <span>{it.label}</span>
              <span className="n">{String(it.n)}</span>
            </div>
          ) : (
            <Row key={it.callsign} callsign={it.callsign} depth={it.depth} noAt={it.noAt} project={it.project} />
          ),
        )}
      </section>
    );
  });

  /** Список; gen — поколение после перестановки: элементы строятся заново. */
  const List = memo(function List({ gen }: { gen: number }) {
    const m = useHeld(listModel);
    const lst = useRef<HTMLDivElement>(null);
    useLayoutEffect(() => {
      if (!follow) return;
      const callsign = follow;
      follow = null;
      lst.current?.querySelector<HTMLElement>(`[data-callsign=${JSON.stringify(callsign)}]`)?.scrollIntoView?.({ block: "nearest" });
    });
    if (!m) return null;
    const empty = <div className="bd-empty">{m.empty}</div>;
    if (m.flat) {
      return (
        <div key={gen} ref={lst} className="lst flat">
          {m.flat.length ? m.flat.map((it) => <Row key={it.callsign} callsign={it.callsign} depth={it.depth} noAt={it.noAt} project={it.project} />) : empty}
        </div>
      );
    }
    return (
      <div key={gen} ref={lst} className="lst">
        {m.sections.flatMap((x) => [x.sep ? <div key="sep" className="pin-sep" aria-hidden="true" /> : null, <ProjectSection key={x.name} x={x} />])}
        {m.sections.length ? null : empty}
      </div>
    );
  });

  /** Ряд фильтров: «Моё», «Всё» и свои; выбранный свой — нажатие правит. */
  const Bar = memo(function Bar({ gen, panel, chip, add, toggle }: { gen: number; panel: boolean; chip(id: string, on: boolean, fixed: boolean): void; add(): void; toggle(): void }) {
    const chips = useHeld(barModel);
    if (!chips) return null;
    return (
      <>
        <div key={gen} className="fscroll" role="tablist" aria-label="Фильтры">
          {chips.map((f) => (
            <button key={f.id} className="fc" role="tab" data-fid={f.id} aria-selected={f.on} onClick={() => chip(f.id, f.on, f.fixed)}>
              {f.name}
              {f.n !== null ? <span className="n">{String(f.n)}</span> : null}
              {f.on && !f.fixed ? (
                <span className="ed" aria-hidden="true">
                  ✎
                </span>
              ) : null}
            </button>
          ))}
        </div>
        <button className="fc add" aria-label="Новый фильтр" onClick={add}>
          +
        </button>
        <button className="fc vw" aria-label="Вид списка" aria-expanded={panel} onClick={toggle}>
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
            <path d="M2 4h7M13 4h1M2 12h1M7 12h7" />
            <circle cx="11" cy="4" r="1.9" />
            <circle cx="5" cy="12" r="1.9" />
          </svg>
        </button>
      </>
    );
  });

  function pick(id: string) {
    flt = id;
    void app.store<string>("flt").set(id);
    app.changed();
  }

  const editorCtx = {
    sessions,
    machines: () => (app.roster()?.machines ?? []).map((m) => m.machine),
    mName,
    owners: () => [...new Set(sessions().map((s) => ownerOf(s)).filter((x): x is string => !!x && x !== me()))].sort(),
    match: (x: Filter, s: SessionRecord) => fits(x, s),
  };

  function BoardScreen() {
    const [gen, setGen] = useState(0);
    const [panel, setPanel] = useState(false);
    const [editor, setEditor] = useState<{ n: number; base: Filter | null } | null>(null);
    const dense = app.use(() => view.dense);
    // на пульте рядом открыт экран сессии: список стоит колонкой
    const side = app.use(() => app.wide && app.current()?.screen !== "board");
    const list = useRef<HTMLDivElement>(null);
    const body = useRef<HTMLDivElement>(null);
    const swallowed = useRef(false);

    useLayoutEffect(() => {
      const root = list.current!;
      listNode = root;
      const ac = new AbortController();
      // конец жеста: сразу новый рисунок — жест дальше читает его элементы; выборки строк догоняют уведомлением
      const redraw = () => {
        flushSync(() => setGen((g) => g + 1));
        app.changed();
      };
      attachProjectDrag(
        {
          root,
          ruleIndex: (name) => {
            const pinned = new Set(top().filter((x) => x !== name));
            return orderProjects(projects().filter((x) => !pinned.has(x.name)), []).findIndex((x) => x.name === name);
          },
          place: (name, vis, k) => p.edit<string[]>("top", (old) => placeTop(old ?? [], name, vis, k)),
          redraw,
        },
        ac.signal,
      );
      attachChipDrag(
        {
          root,
          place: (ids) => p.edit<string[]>("row", () => ids),
          redraw,
          swallow: () => {
            swallowed.current = true;
            setTimeout(() => (swallowed.current = false), 50);
          },
        },
        ac.signal,
      );
      return () => {
        ac.abort();
        listNode = null;
      };
    }, []);

    useLayoutEffect(() => {
      const el = body.current!;
      el.scrollTop = bodyTop;
      return () => {
        bodyTop = el.scrollTop;
      };
    }, []);

    const openEditor = (base: Filter | null) => setEditor((old) => ({ n: (old?.n ?? 0) + 1, base }));
    const closeEditor = () => setEditor(null);
    const setView = (next: View) => {
      view = next;
      void app.store<View>("view").set(view);
      app.changed();
    };

    return (
      <div className={"bd" + (app.wide ? " wide" : "") + (side ? " side" : "")}>
        <div ref={list} className={"bd-list" + (dense ? " dense" : "")}>
          {app.wide ? (
            <div className="bd-lh">
              <b>Работа</b>
              <Btn pri data-new="1" onClick={() => app.open("open", {})}>
                Новая
              </Btn>
            </div>
          ) : null}
          <div className="fbar">
            <Bar
              gen={gen}
              panel={panel}
              chip={(id, on, fixed) => {
                if (swallowed.current) return;
                if (on && !fixed) openEditor(filters().find((f) => f.id === id) ?? null);
                else pick(id);
              }}
              add={() => openEditor(null)}
              toggle={() => setPanel((v) => !v)}
            />
          </div>
          <div ref={body} className="bd-body">
            <List gen={gen} />
          </div>
          {panel ? (
            <ViewPanel
              app={app}
              get={() => view}
              set={(k, v) => setView({ ...view, [k]: v })}
              reset={() => setView({ ...VIEW0 })}
              onClose={() => setPanel(false)}
            />
          ) : null}
          {editor ? (
            <FilterEditor
              key={editor.n}
              ctx={editorCtx}
              base={editor.base}
              save={(clean) => {
                p.edit<Filter[]>("filters", (old) => {
                  const list = old ?? [];
                  return list.some((x) => x.id === clean.id) ? list.map((x) => (x.id === clean.id ? clean : x)) : [...list, clean];
                });
                pick(clean.id);
                closeEditor();
              }}
              remove={(id) => {
                p.edit<Filter[]>("filters", (old) => (old ?? []).filter((x) => x.id !== id));
                if (flt === id) pick("mine");
                closeEditor();
              }}
              close={closeEditor}
            />
          ) : null}
        </div>
        {app.wide ? <div className="bd-pick" /> : null}
      </div>
    );
  }

  /** Закрепления прежней версии лежали на устройстве: один раз переходят к почте. Пересмотр — 1 дек. 2026: устройства перешли, убрать вместе с разделом pins. */
  async function movePins() {
    const old = await app.store<string[]>("pins").get();
    if (!old?.length) return;
    p.edit<string[]>("pins", (cur) => [...new Set([...(cur ?? []), ...old])]);
    await app.store<string[]>("pins").set([]);
  }

  return {
    on: {
      link(state) {
        if (state === "open") void p.read().then(movePins);
      },
    },
    screens: {
      // кнопка карточки: закрепить чужую сессию в «Моём»; своей незачем
      "board.pin": {
        place: "card.menu",
        label: "Закрепить",
        path: "pin",
        show: (x) => {
          const s = session(x.callsign ?? "");
          return !!s && !pins().includes(s.callsign) && !whyMine(s);
        },
        run: (x) => void p.edit<string[]>("pins", (old) => [...new Set([...(old ?? []), x.from ?? ""])]),
      },
      "board.unpin": {
        place: "card.menu",
        label: "Закреплена",
        path: "unpin",
        show: (x) => pins().includes(x.callsign ?? ""),
        run: (x) => void p.edit<string[]>("pins", (old) => (old ?? []).filter((c) => c !== x.from)),
      },
      board: {
        nav: "Работа",
        label: "Работа",
        path: "sessions",
        view: BoardScreen,
        head: () => ({ title: "Работа", action: { label: "Новая сессия", text: "+", run: () => app.open("open", {}) } }),
        // Ctrl K ведёт сразу на сессию: найденная разворачивает свой проект
        find: (q) =>
          sessions()
            .filter((s) => !q || `${s.callsign} ${sName(s.callsign)} ${mName(machineOf(s.callsign) ?? "")} ${projectOf(s.dir)}`.toLowerCase().includes(q))
            .sort(byRank)
            .map((s) => ({ label: sName(s.callsign), hint: `${mName(machineOf(s.callsign) ?? "")} · ${projectOf(s.dir)}`, dot: lamp(s), screen: "card", params: { callsign: s.callsign } })),
      },
    },
    marks: {
      /** почему сессия моя; не моя — "" */
      mine: (callsign: string) => {
        const s = session(callsign);
        return s ? whyMine(s) : "";
      },
      /** машины сессий проекта */
      "project.machines": (project: string) => [...new Set(sessions().filter((s) => projectOf(s.dir) === project).map((s) => machineOf(s.callsign) ?? ""))].filter(Boolean),
      /** открытый или последний проект */
      "project.current": () => lastProject,
    },
    store: ["flt", "collapsed", "view", "pins"],
    css,
    async start(a) {
      app = a;
      p ??= personal(app, "web-board", () => app.changed());
      flt = (await app.store<string>("flt").get()) ?? "mine";
      col = (await app.store<Record<string, boolean>>("collapsed").get()) ?? {};
      view = { ...VIEW0, ...(await app.store<View>("view").get()) };
    },
    async stop() {
      await p?.settled();
    },
  };
}
