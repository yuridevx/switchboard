// web-board — «Работа»: сессии всех машин по проектам в одном списке для колонки пульта и экрана телефона. Проект — последнее имя папки
// (правило projectOf ядра). Настройки человека — у его почты (Worker prefs, ключи web-board.*): свои фильтры, порядок фильтров, закреплённые
// проекты и сессии; одни на всех его устройствах. Настройки устройства — в хранилище страницы: выбранный фильтр, свёрнутые проекты, вид списка.
// «Моё» — сессия, ввод или открытие которой пришли от моего адреса (имя~почта), её дочери и закреплённые; метка mine — одно место этого правила.
import { h, myAddress, personal, projectOf, stateLabel, type App, type AppModule, type Personal, type ScreenHandle, type SessionRecord } from "@switchboard/web-core";
import { kindOf, machineOf, userOf } from "@switchboard/protocol";
import { attachChipDrag, CHIPS_CSS } from "./chips-drag.ts";
import { BOARD_CSS } from "./css.ts";
import { filterEditor } from "./filters.ts";
import { attachProjectDrag, PROJECTS_CSS } from "./projects-drag.ts";
import { BUILT, byRank, incidentOf, match, orderFilters, orderProjects, parentOf, placeTop, profileOf, rank, tree, type Filter, type Project } from "./rules.ts";
import { VIEW0, viewPanel, type View, type ViewPanel } from "./view.ts";

type Shown = { text: string; human: boolean };

const PIN = '<svg class="bd-pin" viewBox="0 0 16 16" role="img" aria-label="закреплена"><path d="M6 2h4l-.5 4 2.5 2.5V10H8.6L8 14l-.6-4H4V8.5L6.5 6z"/></svg>';
const VIEW_ICON = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M2 4h7M13 4h1M2 12h1M7 12h7"/><circle cx="11" cy="4" r="1.9"/><circle cx="5" cy="12" r="1.9"/></svg>';

const lamp = (s: SessionRecord) => (s.state === "failed" ? "bad" : stateLabel(s.state).dot || "stop");
const htmlOf = (markup: string) => {
  const t = document.createElement("template");
  t.innerHTML = markup;
  return t.content.firstElementChild as HTMLElement;
};

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

  const sLabel = (callsign: string) => app.mark("label.session", callsign) as Shown | undefined;
  const mLabel = (machine: string) => app.mark("label.machine", machine) as Shown | undefined;
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
  function line(s: SessionRecord): Array<HTMLElement | null> {
    const asked = app.mark("asked", s.callsign) as string | undefined;
    if (asked && view.q) return [h("span", { class: "tx q" }, `? ${asked}`)];
    const unread = app.mark("unread", s.callsign) as { count: number; text: string } | undefined;
    if (unread?.text && view.unread) return [h("span", { class: "tx" }, unread.text)];
    if (s.state === "failed" && s.failed && view.fail) return [h("span", { class: "tx f" }, Object.values(s.failed as Record<string, string>).join("; "))];
    const prof = profileOf(s);
    return [prof && view.prof ? h("span", { class: "bd-pill" }, prof) : null, typeof s.model === "string" && s.model && view.model ? h("span", { class: "tx" }, s.model) : null];
  }

  function openSession(s: SessionRecord) {
    lastProject = projectOf(s.dir);
    // телефон: сессия с вопросом — сразу вопрос; пульт — карточка, вопрос в разговоре
    if (!app.wide && app.mark("asked", s.callsign)) app.open("ask", { callsign: s.callsign });
    else app.open("card", { callsign: s.callsign });
  }

  function rowEl(s: SessionRecord, depth: number, mail: string | null, noAt: boolean, project: string | null): HTMLElement {
    const asked = app.mark("asked", s.callsign) as string | undefined;
    const unread = app.mark("unread", s.callsign) as { count: number } | undefined;
    const machine = machineOf(s.callsign) ?? "";
    const owner = view.owner && !whyMine(s, mail) ? ownerOf(s) : null;
    const inc = view.inc ? incidentOf(s) : undefined;
    const t2 = [project ? h("span", { class: "prj" }, project) : null, ...line(s)].filter(Boolean);
    return h(
      "button",
      {
        class: "bd-row" + (depth ? " kid" : ""),
        "data-callsign": s.callsign,
        "aria-current": app.current()?.params.callsign === s.callsign ? "true" : "false",
        style: depth ? `padding-left:${10 + depth * 22}px` : null,
        onclick: () => openSession(s),
      },
      view.lamp ? h("span", { class: `sb-dot ${lamp(s)}`, title: stateLabel(s.state).text }) : null,
      h(
        "span",
        { class: "bd-rt" },
        h(
          "span",
          { class: "bd-t1" },
          h("b", { class: "bd-cs" + (sLabel(s.callsign)?.human ? " hum" : "") }, sName(s.callsign)),
          owner ? h("span", { class: "bd-pill own" }, owner.slice(1, owner.indexOf("@"))) : null,
          inc ? h("span", { class: "bd-pill inc" }, inc) : null,
          view.pin && pins().includes(s.callsign) ? htmlOf(PIN) : null,
          view.at && !noAt ? h("span", { class: "bd-at" + (mLabel(machine)?.human ? " hum" : "") }, mName(machine)) : null,
        ),
        t2.length ? h("span", { class: "bd-t2" }, t2) : null,
      ),
      !view.badge ? null : asked ? h("span", { class: "sb-badge wait", "aria-label": "ждёт ответа" }, "?") : unread?.count ? h("span", { class: "sb-badge" }, unread.count) : null,
    );
  }

  /** Строки проекта: деревом или ровно; лёгкие группы по машинам — если включены в виде. */
  function rowsOf(ss: SessionRecord[], mail: string | null, noAt: boolean): HTMLElement[] {
    const ordered: Array<[SessionRecord, number]> = view.tree ? tree(ss) : [...ss].sort(byRank).map((s) => [s, 0]);
    return ordered.map(([s, d]) => rowEl(s, d, mail, noAt, null));
  }
  function projectRows(x: Project, mail: string | null): HTMLElement[] {
    if (!view.group) return rowsOf(x.ss, mail, false);
    const by = new Map<string, SessionRecord[]>();
    for (const s of x.ss) {
      const m = machineOf(s.callsign) ?? "";
      by.set(m, [...(by.get(m) ?? []), s]);
    }
    return [...by]
      .sort((a, b) => Math.min(...a[1].map(rank)) - Math.min(...b[1].map(rank)) || a[0].localeCompare(b[0]))
      .flatMap(([m, ss]) => [h("div", { class: "mgrp", "data-group": m }, h("span", null, mName(m)), h("span", { class: "n" }, String(ss.length))), ...rowsOf(ss, mail, true)]);
  }

  /** «+» у проекта — место его верхней сессии, чья машина на связи. */
  function newIn(x: Project) {
    const online = new Set((app.roster()?.machines ?? []).filter((m) => m.contract?.["session.open"] !== undefined).map((m) => m.machine));
    const s = tree(x.ss).map(([y]) => y).find((y) => online.has(machineOf(y.callsign) ?? "") && typeof y.dir === "string");
    app.open("open", s ? { machine: machineOf(s.callsign)!, dir: s.dir as string } : {});
  }

  function saveCol() {
    void app.store<Record<string, boolean>>("collapsed").set(col);
  }

  function listEl(mail: string | null): HTMLElement {
    const ps = projects();
    const cur = currentFilter();
    const empty = () => h("div", { class: "bd-empty" }, `в «${cur.name}» сессий нет`);
    // без группировки по проектам — плоский список: ждут вас, работают, по имени; проект — в строке
    if (!view.projects) {
      const flat = ps.flatMap((x) => x.ss).sort(byRank);
      return h("div", { class: "lst flat" }, flat.length ? flat.map((s) => rowEl(s, 0, mail, false, projectOf(s.dir))) : empty());
    }
    const lst = h("div", { class: "lst" });
    let seen = false;
    let sep = false;
    for (const x of ps) {
      // впервые увиденный проект развёрнут, только если в нём ждут вас или сбой; дальше — как оставил человек
      if (col[x.name] === undefined) {
        col[x.name] = x.r !== 0;
        seen = true;
      }
      const open = !col[x.name];
      const pinned = top().includes(x.name);
      // граница закреплённых и остальных — тонкая черта
      if (!pinned && !sep && ps.some((y) => top().includes(y.name))) {
        sep = true;
        lst.append(h("div", { class: "pin-sep", "aria-hidden": "true" }));
      }
      lst.append(
        h(
          "section",
          { class: "pjs" + (pinned ? " pinned" : ""), "data-proj": x.name },
          h(
            "div",
            { class: "pj" },
            view.grip ? h("span", { class: "grip", role: "button", tabindex: "0", "data-proj": x.name, "aria-label": `Переместить ${x.name}: перетащить или стрелки` }, "⠿") : null,
            h(
              "button",
              {
                class: "pj-t",
                "aria-expanded": String(open),
                "data-proj": x.name,
                onclick: () => {
                  col[x.name] = !col[x.name];
                  saveCol();
                  app.changed();
                },
              },
              h("span", { class: "car" }, "▼"),
              h("span", { class: "nm" }, x.name),
              h("span", { class: "lamps" }, !open && view.pjlamps ? x.ss.slice(0, 6).map((s) => h("span", { class: `sb-dot ${lamp(s)}` })) : null, view.pjcount ? h("span", { class: "n" }, String(x.ss.length)) : null),
            ),
            view.add ? h("button", { class: "pj-add", "data-proj": x.name, "aria-label": `Новая сессия в ${x.name}`, onclick: () => newIn(x) }, "+") : null,
          ),
          open ? projectRows(x, mail) : null,
        ),
      );
    }
    if (seen) saveCol();
    if (!ps.length) lst.append(empty());
    return lst;
  }

  /** Найденная или только что открытая сессия видна: её проект разворачивается. */
  function followCurrent(): boolean {
    const c = app.current();
    const callsign = c?.params.callsign;
    if (callsign === lastCurrent) return false;
    lastCurrent = callsign;
    const s = callsign ? session(callsign) : undefined;
    if (!s) return false;
    const name = projectOf(s.dir);
    lastProject = name;
    if (col[name] !== false) {
      col[name] = false;
      saveCol();
    }
    return true;
  }

  function mountBoard(el: HTMLElement): ScreenHandle {
    const body = h("div", { class: "bd-body" });
    const bar = h("div", { class: "fbar" });
    const list = h("div", { class: "bd-list" }, app.wide ? h("div", { class: "bd-lh" }, h("b", null, "Работа"), h("button", { class: "sb-b pri", "data-new": "1", onclick: () => app.open("open", {}) }, "Новая")) : null, bar, body);
    el.append(h("div", { class: "bd" }, list, app.wide ? h("div", { class: "bd-pick" }) : null));

    let panel: ViewPanel | null = null;
    let editor: HTMLElement | null = null;
    let swallowed = false;
    const ac = new AbortController();

    const closeEditor = () => {
      editor?.remove();
      editor = null;
    };
    function openEditor(f: Filter | null) {
      closeEditor();
      editor = filterEditor(
        {
          sessions,
          machines: () => (app.roster()?.machines ?? []).map((m) => m.machine),
          mName,
          owners: () => [...new Set(sessions().map((s) => ownerOf(s)).filter((x): x is string => !!x && x !== me()))].sort(),
          match: (x, s) => fits(x, s),
        },
        f,
        {
          save: (clean) => {
            p.edit<Filter[]>("filters", (old) => {
              const list = old ?? [];
              return list.some((x) => x.id === clean.id) ? list.map((x) => (x.id === clean.id ? clean : x)) : [...list, clean];
            });
            pick(clean.id);
            closeEditor();
          },
          remove: (id) => {
            p.edit<Filter[]>("filters", (old) => (old ?? []).filter((x) => x.id !== id));
            if (flt === id) pick("mine");
            closeEditor();
          },
          close: closeEditor,
        },
      );
      list.append(editor);
    }

    function pick(id: string) {
      flt = id;
      void app.store<string>("flt").set(id);
      draw();
    }

    function toggleView() {
      if (panel) {
        panel.close();
        panel = null;
        draw();
        return;
      }
      panel = viewPanel(app, {
        get: () => view,
        set: (k, v) => {
          view = { ...view, [k]: v };
          void app.store<View>("view").set(view);
          draw();
        },
        reset: () => {
          view = { ...VIEW0 };
          void app.store<View>("view").set(view);
          draw();
        },
        onClose: toggleView,
      });
      list.append(panel.el);
      draw();
    }

    /** Ряд фильтров: «Моё», «Всё» и свои; число — сколько сессий подходит; выбранный свой — нажатие правит. */
    function drawBar(mail: string | null) {
      const left = bar.querySelector(".fscroll")?.scrollLeft ?? 0;
      const cur = currentFilter();
      const scroll = h(
        "div",
        { class: "fscroll", role: "tablist", "aria-label": "Фильтры" },
        filters().map((f) => {
          const on = f.id === cur.id;
          const n = sessions().filter((s) => fits(f, s, mail)).length;
          return h(
            "button",
            {
              class: "fc",
              role: "tab",
              "data-fid": f.id,
              "aria-selected": String(on),
              onclick: () => {
                if (swallowed) return;
                if (on && !f.fixed) openEditor(f);
                else pick(f.id);
              },
            },
            f.name,
            view.fcount ? h("span", { class: "n" }, String(n)) : null,
            on && !f.fixed ? h("span", { class: "ed", "aria-hidden": "true" }, "✎") : null,
          );
        }),
      );
      const vw = h("button", { class: "fc vw", "aria-label": "Вид списка", "aria-expanded": String(!!panel), onclick: toggleView });
      vw.append(htmlOf(VIEW_ICON));
      bar.replaceChildren(scroll, h("button", { class: "fc add", "aria-label": "Новый фильтр", onclick: () => openEditor(null) }, "+"), vw);
      scroll.scrollLeft = left;
    }

    function draw() {
      // первый рисунок ждёт ответа prefs; связи нет вовсе — рисуем встроенное
      if (!app.roster() || (!p.ready() && app.link() === "open")) return;
      // перестановка идёт — перерисует её конец
      if (list.classList.contains("reordering")) return;
      const ae = document.activeElement as HTMLElement | null;
      const focus = ae && list.contains(ae) && !ae.closest(".bd-vw, .bd-veil") ? "." + ae.classList[0] + Object.entries(ae.dataset).map(([k, v]) => `[data-${k}=${JSON.stringify(v)}]`).join("") : null;
      const mail = me();
      const moved = followCurrent();
      list.classList.toggle("dense", view.dense);
      drawBar(mail);
      body.replaceChildren(listEl(mail));
      if (focus) list.querySelector<HTMLElement>(focus)?.focus({ preventScroll: true });
      if (moved) body.querySelector<HTMLElement>(`[data-callsign=${JSON.stringify(lastCurrent)}]`)?.scrollIntoView?.({ block: "nearest" });
    }

    attachProjectDrag(
      {
        root: list,
        ruleIndex: (name) => {
          const pinned = new Set(top().filter((x) => x !== name));
          return orderProjects(projects().filter((x) => !pinned.has(x.name)), []).findIndex((x) => x.name === name);
        },
        place: (name, vis, k) => p.edit<string[]>("top", (old) => placeTop(old ?? [], name, vis, k)),
        redraw: draw,
      },
      ac.signal,
    );
    attachChipDrag(
      {
        root: list,
        place: (ids) => p.edit<string[]>("row", () => ids),
        redraw: draw,
        swallow: () => {
          swallowed = true;
          setTimeout(() => (swallowed = false), 50);
        },
      },
      ac.signal,
    );
    draw();
    body.scrollTop = bodyTop;
    return {
      head: () => ({ title: "Работа", action: { label: "Новая сессия", text: "+", run: () => app.open("open", {}) } }),
      refresh: draw,
      close: () => {
        bodyTop = body.scrollTop;
        ac.abort();
        panel?.close();
        closeEditor();
      },
    };
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
        mount: (_el, x) => void p.edit<string[]>("pins", (old) => [...new Set([...(old ?? []), x.from ?? ""])]),
      },
      "board.unpin": {
        place: "card.menu",
        label: "Закреплена",
        path: "unpin",
        show: (x) => pins().includes(x.callsign ?? ""),
        mount: (_el, x) => void p.edit<string[]>("pins", (old) => (old ?? []).filter((c) => c !== x.from)),
      },
      board: {
        nav: "Работа",
        label: "Работа",
        path: "sessions",
        mount: mountBoard,
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
    css: BOARD_CSS + PROJECTS_CSS + CHIPS_CSS,
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
