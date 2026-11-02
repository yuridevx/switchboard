// web-board — «Работа»: сессии всех машин по проектам. Проект — последнее имя папки поля dir; «моё» — сессия, ввод
// или открытие которой пришли от моего адреса (имя~почта), её дочери и закреплённые. Внутри проекта — группы по
// профилям или машинам, в группе — дерево по parent. Машины проекта — выбор устройства (раздел хранилища projects);
// по умолчанию — машины его сессий. Метки mine, project и project.machines — одно место этих правил для других модулей.
import { h, plural, stateLabel, type App, type AppModule, type Params, type Roster, type ScreenHandle, type SessionRecord } from "@switchboard/web-core";
import { kindOf, machineOf } from "@switchboard/protocol";

const CSS = `
.bd{flex:1;min-height:0;display:grid;grid-template-columns:minmax(0,1fr)}
.sb-app.wide .bd{grid-template-columns:minmax(280px,340px) minmax(0,1fr)}
.sb-master .bd{grid-template-columns:minmax(0,1fr)}
.sb-master .bd-pick{display:none}
.bd-list{display:flex;flex-direction:column;min-height:0;background:var(--surface);border-right:1px solid var(--line2)}
.bd-lh{padding:14px 14px 8px;display:flex;flex-direction:column;gap:8px;border-bottom:1px solid var(--line2)}
.bd-lh .t{display:flex;align-items:center;gap:8px}
.bd-lh b{font:600 19px/1.2 var(--body);flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bd-lh .s{font-size:12px;color:var(--muted)}
.bd-segs{display:flex;justify-content:space-between;gap:8px}
.bd-seg{display:flex;gap:4px}
.bd-seg button,.bd-chips button{border:1px solid var(--line2);background:var(--surface2);border-radius:999px;padding:3px 10px;font:500 12px var(--body);color:var(--ink);white-space:nowrap}
.bd-seg button[aria-pressed="true"],.bd-chips button[aria-pressed="true"]{background:var(--accent);color:var(--on-accent);border-color:var(--accent)}
.bd-chips{display:flex;gap:6px;overflow-x:auto;padding:10px 12px 2px;scrollbar-width:none}
.bd-chips button{flex:none}
.bd-chips i{font-style:normal;color:var(--muted);margin-left:3px}
.bd-chips button[aria-pressed="true"] i{color:inherit}
.bd-body{flex:1;min-height:0;overflow-y:auto;padding:4px 6px 12px}
.bd-proj{display:flex;align-items:center;gap:8px;padding:12px 10px 4px;font:600 12.5px var(--body)}
.bd-proj span{font-weight:400;font-size:11.5px;color:var(--muted)}
.bd-grp{display:flex;align-items:center;gap:7px;padding:8px 10px 2px 12px;font-size:11.5px;color:var(--muted)}
.bd-grp .p{font:600 11.5px var(--body);color:var(--ink);background:var(--surface2);border:1px solid var(--line2);border-radius:999px;padding:1px 8px}
.bd-grp .m{font:600 12px var(--mono);color:var(--ink)}
.bd-grp .sb-dot{width:7px;height:7px;animation:none;box-shadow:none}
.bd-row{display:flex;gap:10px;align-items:flex-start;width:100%;text-align:left;border:0;background:transparent;border-radius:9px;padding:8px 10px;color:var(--ink)}
.bd-row:hover{background:var(--surface2)}
.bd-row[aria-current="true"]{background:var(--accent-weak)}
.bd-row .sb-dot{width:9px;height:9px;margin-top:5px;flex:none}
.bd-rt{flex:1;min-width:0;display:flex;flex-direction:column}
.bd-t1{display:flex;gap:6px;align-items:baseline;min-width:0}
.bd-t1 b{font:600 13px var(--mono);white-space:nowrap}
.bd-t1 .st{margin-left:auto;font-size:11.5px;color:var(--muted);white-space:nowrap}
.bd-t2{font-size:12.5px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bd-tag{font:500 11px var(--body);border-radius:999px;padding:1px 7px;background:var(--surface2);color:var(--muted);white-space:nowrap}
.bd-tag.inc{background:var(--wait-weak);color:var(--wait)}
.bd-row .sb-badge{flex:none;align-self:center}
.bd-pin{font-size:12px;color:var(--muted)}
.bd-more{display:flex;justify-content:space-between;align-items:center;gap:8px;font-size:12px;color:var(--muted);padding:6px 12px}
.bd-more button,.bd-link{border:0;background:none;color:var(--ink);font:600 12px var(--body);padding:2px 4px;white-space:nowrap}
.bd-empty{color:var(--muted);text-align:center;padding:36px 12px}
.bd-pick{display:flex;align-items:center;justify-content:center;color:var(--muted);font-size:14px}
@media (max-width:760px){.sb-app.wide .bd{grid-template-columns:minmax(0,1fr)}.bd-pick{display:none}}
/* окно «Машины проекта» */
.bd-veil{position:fixed;inset:0;z-index:15;background:rgba(10,15,12,.38);display:flex;align-items:flex-start;justify-content:center;padding-top:70px}
.bd-dlg{width:min(560px,92%);max-height:calc(100% - 100px);background:var(--surface);border:1px solid var(--line);border-radius:14px;box-shadow:0 20px 60px rgba(0,0,0,.25);display:flex;flex-direction:column;overflow:hidden}
.bd-dh{display:flex;align-items:center;gap:10px;padding:14px 16px 10px;font:600 17px var(--body)}
.bd-dh span{flex:1}
.bd-dh button{border:0;background:none;font-size:16px;color:var(--muted)}
.bd-db{padding:0 16px 10px;display:flex;flex-direction:column;gap:8px;min-height:0}
.bd-db input{border:1px solid var(--line);border-radius:8px;padding:7px 10px;font:14px var(--body);background:var(--bg);color:var(--ink)}
.bd-fl{display:flex;flex-direction:column;gap:2px;overflow-y:auto;max-height:360px}
.bd-fr{display:flex;align-items:center;gap:9px;border:0;background:transparent;text-align:left;padding:7px 8px;border-radius:8px;color:var(--ink)}
.bd-fr:hover{background:var(--surface2)}
.bd-fr .box{width:18px;height:18px;border:1.5px solid var(--line);border-radius:5px;display:grid;place-items:center;font-size:12px;flex:none}
.bd-fr[aria-checked="true"] .box{background:var(--accent);border-color:var(--accent);color:var(--on-accent)}
.bd-fr b{font:500 13px var(--mono);flex:1}
.bd-fr span:last-child{font-size:12px;color:var(--muted)}
.bd-df{display:flex;align-items:center;gap:8px;padding:12px 16px;border-top:1px solid var(--line2)}
.bd-df span{flex:1;font-size:12px;color:var(--muted)}
.bd-df button{border:1px solid var(--line);background:var(--surface);border-radius:8px;padding:6px 11px;font:600 13px var(--body);color:var(--ink)}
.bd-df button.pri{background:var(--accent);border-color:var(--accent);color:var(--on-accent)}
`;

/** Короткая подпись состояния строки. */
const SHORT: Record<string, string> = { busy: "работает", waiting: "ждёт вас", idle: "свободна", stopped: "остановлена", failed: "не запустилась", starting: "запускается", stopping: "останавливается" };
/** Порядок: ждёт вас, работает, остальные. */
const rank = (s: SessionRecord) => (s.state === "waiting" || s.state === "failed" ? 0 : s.state === "busy" || s.state === "starting" ? 1 : 2);
const profileOf = (s: SessionRecord) => (s.profile as { id?: string } | null | undefined)?.id?.split("/").at(-1);
const incidentOf = (s: SessionRecord) => (s.incident as { type?: string } | null | undefined)?.type;
/** Профиль сессии для группы: без профиля — одна группа. */
const profOf = (s: SessionRecord) => profileOf(s) ?? "без профиля";

/** Проект сессии — последнее имя папки dir; домашняя папка — «домашняя папка». Одно правило для всех модулей — метка project. */
export function projectOf(s: SessionRecord): string {
  const dir = typeof s.dir === "string" && s.dir ? s.dir : "~";
  if (dir === "~") return "домашняя папка";
  return dir.replace(/[\\/]+$/, "").split(/[\\/]/).pop()!.toLowerCase();
}

/** Родитель-сессия из поля parent; устройство и машина — не родитель для дерева. */
const parentOf = (s: SessionRecord) => (typeof s.parent === "string" && kindOf(s.parent) === "session" && s.parent !== s.callsign ? s.parent : null);

/** Порядок дерева: дочь сразу под родителем, глубина — отступ; родителя нет в списке — дочь в корне. */
export function tree(list: SessionRecord[]): Array<[SessionRecord, number]> {
  const here = new Set(list.map((s) => s.callsign));
  const kids = new Map<string, SessionRecord[]>();
  const roots: SessionRecord[] = [];
  const by = (a: SessionRecord, b: SessionRecord) => rank(a) - rank(b) || a.callsign.localeCompare(b.callsign);
  for (const s of [...list].sort(by)) {
    const p = parentOf(s);
    if (p && here.has(p)) kids.set(p, [...(kids.get(p) ?? []), s]);
    else roots.push(s);
  }
  const out: Array<[SessionRecord, number]> = [];
  const seen = new Set<string>();
  const walk = (s: SessionRecord, d: number) => {
    if (seen.has(s.callsign)) return;
    seen.add(s.callsign);
    out.push([s, d]);
    for (const k of kids.get(s.callsign) ?? []) walk(k, d + 1);
  };
  for (const s of roots) walk(s, 0);
  // родители по кругу — в корень
  for (const s of list) walk(s, 0);
  return out;
}

type Project = { name: string; sessions: SessionRecord[]; machines: string[]; rank: number };

/** Новый модуль со своей памятью (в выпуске — один; в тестах — на каждый прогон). */
export function createBoard(): AppModule {
  let app: App;
  /** машины проекта, выбранные на этом устройстве: проект → машины */
  let chosen: Record<string, string[]> = {};
  /** закреплённые на этом устройстве сессии — «моё» независимо от того, кто дал задачу */
  let pins: string[] = [];
  let onlyMine = true;
  let group: "profile" | "machine" = "profile";
  let lastProject: string | null = null;
  const redraws = new Set<() => void>();

  const sessions = () => app?.roster()?.sessions ?? [];

  /** Мой адрес во флоте — среди клиентов roster: имя устройства и почта. */
  function myEmail(): string | null {
    const me = (app?.roster()?.clients ?? []).find((c) => c.startsWith(`${app.name}~`));
    return me ? me.slice(me.indexOf("~") + 1) : null;
  }
  const isMe = (a: unknown, email: string | null) => !!email && typeof a === "string" && a.includes("~") && a.slice(a.indexOf("~") + 1) === email;

  /** Почему сессия моя: задачу дали вы, открыли вы, открыла ваша сессия; не моя — "". */
  function whyMine(s: SessionRecord, email = myEmail(), depth = 0): string {
    if (pins.includes(s.callsign)) return "закреплена вами";
    if (isMe(s.from, email)) return "задачу дали вы";
    if (isMe(s.parent, email)) return "открыли вы";
    // открыла или дала задачу сессия — моя, если моя она
    const sender = typeof s.from === "string" && kindOf(s.from) === "session" && s.from !== s.callsign ? s.from : null;
    const p = parentOf(s) ?? sender;
    const ps = p ? sessions().find((x) => x.callsign === p) : undefined;
    if (ps && depth < 8 && whyMine(ps, email, depth + 1)) return `открыла ваша ${ps.callsign}`;
    return "";
  }

  /** Машины проекта: выбранные, иначе машины его сессий. */
  function machinesOf(project: string): string[] {
    return chosen[project] ?? [...new Set(sessions().filter((s) => projectOf(s) === project).map((s) => machineOf(s.callsign) ?? ""))].filter(Boolean);
  }
  const inProject = (s: SessionRecord) => machinesOf(projectOf(s)).includes(machineOf(s.callsign) ?? "");

  /** Проекты: сессии на машинах проекта; порядок — ждёт вас, работает, остальные; внутри — по имени. */
  function projects(mine: boolean): Project[] {
    const email = myEmail();
    const g = new Map<string, SessionRecord[]>();
    for (const s of sessions()) {
      if (mine && !whyMine(s, email)) continue;
      const p = projectOf(s);
      g.set(p, [...(g.get(p) ?? []), s]);
    }
    return [...g]
      .map(([name, ss]) => ({ name, sessions: ss, machines: [...new Set(ss.map((s) => machineOf(s.callsign) ?? ""))], rank: Math.min(...ss.map(rank)) }))
      .sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
  }

  /** Закрепить или открепить сессию на этом устройстве; ответ — закреплена ли теперь. */
  async function togglePin(callsign: string): Promise<boolean> {
    pins = pins.includes(callsign) ? pins.filter((x) => x !== callsign) : [...pins, callsign];
    await app.store<string[]>("pins").set(pins);
    app.changed();
    return pins.includes(callsign);
  }

  async function save() {
    await app.store<Record<string, string[]>>("projects").set(chosen);
  }

  /** Строка второй строки: вопрос, сообщение, причина сбоя или модель · профиль. */
  function line(s: SessionRecord): string {
    const asked = app.mark("asked", s.callsign) as string | undefined;
    if (asked) return `? ${asked}`;
    const unread = app.mark("unread", s.callsign) as { count: number; text: string } | undefined;
    if (unread?.text) return unread.text;
    if (s.state === "failed" && s.failed) return Object.values(s.failed as Record<string, string>).join("; ");
    return [s.model, profileOf(s)].filter((x) => typeof x === "string" && x).join(" · ");
  }

  function row(s: SessionRecord, depth: number, email: string | null): HTMLElement {
    const asked = app.mark("asked", s.callsign) as string | undefined;
    const unread = app.mark("unread", s.callsign) as { count: number } | undefined;
    const st = stateLabel(s.state);
    const sel = app.current()?.params.callsign === s.callsign;
    return h(
      "button",
      {
        class: "bd-row" + (depth ? " kid" : ""),
        "data-callsign": s.callsign,
        "aria-current": sel ? "true" : "false",
        style: depth ? `padding-left:${10 + depth * 18}px` : null,
        onclick: () => {
          lastProject = projectOf(s);
          // телефон: сессия с вопросом — сразу вопрос; пульт — карточка, вопрос в разговоре
          if (!app.wide && app.mark("asked", s.callsign)) app.open("ask", { callsign: s.callsign });
          else app.open("card", { callsign: s.callsign });
        },
      },
      h("span", { class: `sb-dot ${s.state === "failed" ? "bad" : st.dot}`, title: SHORT[String(s.state)] ?? st.text }),
      h(
        "span",
        { class: "bd-rt" },
        h(
          "span",
          { class: "bd-t1" },
          depth ? h("span", { class: "bd-tag" }, "↳") : null,
          h("b", null, s.callsign),
          pins.includes(s.callsign) ? h("span", { class: "bd-pin", title: "закреплена" }, "⌖") : null,
          incidentOf(s) ? h("span", { class: "bd-tag inc" }, incidentOf(s)!) : null,
          whyMine(s, email) ? null : h("span", { class: "bd-tag" }, "чужая"),
          h("span", { class: "st" }, SHORT[String(s.state)] ?? st.text),
        ),
        h("span", { class: "bd-t2" }, line(s)),
      ),
      asked ? h("span", { class: "sb-badge wait", "aria-label": "ждёт ответа" }, "?") : unread?.count ? h("span", { class: "sb-badge" }, unread.count) : null,
    );
  }

  /** Окно «Машины проекта»: все машины roster, поиск, «все машины флота». */
  function focusDialog(project: string, done: () => void): HTMLElement {
    let q = "";
    const veil = h("div", { class: "bd-veil", "data-focus": project });
    const close = () => {
      veil.remove();
      done();
    };
    veil.addEventListener("click", (e) => e.target === veil && close());
    function draw() {
      const all = (app.roster()?.machines ?? []).map((m) => m.machine).sort();
      const pm = machinesOf(project);
      const n = (m: string) => sessions().filter((s) => machineOf(s.callsign) === m).length;
      const input = h("input", { placeholder: "Найти машину", "aria-label": "Найти машину", value: q }) as HTMLInputElement;
      input.addEventListener("input", () => {
        q = input.value;
        draw();
        const again = veil.querySelector<HTMLInputElement>("input")!;
        again.focus();
        again.setSelectionRange(q.length, q.length);
      });
      const toggle = (m: string) => {
        chosen[project] = pm.includes(m) ? pm.filter((x) => x !== m) : [...pm, m];
        void save();
        draw();
        app.changed();
      };
      veil.textContent = "";
      veil.append(
        h(
          "div",
          { class: "bd-dlg", role: "dialog", "aria-label": `Машины проекта ${project}` },
          h("div", { class: "bd-dh" }, h("span", null, `Машины проекта ${project}`), h("button", { "aria-label": "Закрыть", onclick: close }, "✕")),
          h(
            "div",
            { class: "bd-db" },
            input,
            h(
              "div",
              { class: "bd-fl" },
              all
                .filter((m) => !q || m.includes(q.toLowerCase()))
                .map((m) =>
                  h(
                    "button",
                    { class: "bd-fr", role: "checkbox", "aria-checked": String(pm.includes(m)), "data-machine": m, onclick: () => toggle(m) },
                    h("span", { class: "box" }, pm.includes(m) ? "✓" : ""),
                    h("b", null, `@${m}`),
                    h("span", null, n(m) ? `${n(m)} сесс.` : ""),
                  ),
                ),
            ),
          ),
          h(
            "div",
            { class: "bd-df" },
            h("button", { onclick: () => ((chosen[project] = all), void save(), draw(), app.changed()) }, "Все машины флота"),
            h("span", null, `в проекте ${pm.length} из ${all.length}`),
            h("button", { class: "pri", onclick: close }, "Готово"),
          ),
        ),
      );
    }
    draw();
    return veil;
  }

  function mountBoard(el: HTMLElement, params: Params): ScreenHandle {
    const project = params.project || null;
    if (project) lastProject = project;
    // строка поиска Ctrl K ведёт на сессию — список открывает её карточку (поиск ведёт только на экраны своего модуля)
    if (params.callsign) queueMicrotask(() => app.open("card", { callsign: params.callsign }));
    const head = h("div", { class: "bd-lh" });
    const chips = h("div", { class: "bd-chips", role: "tablist", "aria-label": "Проекты" });
    const body = h("div", { class: "bd-body" });
    el.append(h("div", { class: "bd" }, h("div", { class: "bd-list" }, head, app.wide ? null : chips, body), app.wide ? h("div", { class: "bd-pick" }, "Выберите сессию") : null));

    function seg(label: string, on: boolean, act: () => void, data: string) {
      return h("button", { "aria-pressed": String(on), "data-seg": data, onclick: () => (act(), draw()) }, label);
    }

    function draw() {
      if (!app.roster()) return;
      const email = myEmail();
      const all = projects(onlyMine);
      const p = project ? all.find((x) => x.name === project) : undefined;
      // шапка: имя проекта или «Работа», профили · машины проекта, переключатели
      head.textContent = "";
      head.append(
        h("div", { class: "t" }, h("b", null, project ?? "Работа"), h("button", { class: "sb-b pri", "data-new": "1", onclick: () => app.open("open", project ? { project } : {}) }, app.wide ? "Новая задача" : "＋")),
        ...(p ? [h("div", { class: "s" }, [[...new Set(p.sessions.map(profOf))].join(", "), machinesOf(p.name).join(", ")].filter(Boolean).join(" · "))] : []),
        h(
          "div",
          { class: "bd-segs" },
          h("div", { class: "bd-seg", role: "group", "aria-label": "Чьи сессии" }, seg("Моё", onlyMine, () => (onlyMine = true), "mine"), seg("Всё", !onlyMine, () => (onlyMine = false), "all")),
          h("div", { class: "bd-seg", role: "group", "aria-label": "Группировка" }, seg("по профилям", group === "profile", () => (group = "profile"), "profile"), seg("по машинам", group === "machine", () => (group = "machine"), "machine")),
        ),
      );
      // телефон: проекты лентой
      chips.textContent = "";
      chips.append(
        h("button", { "aria-pressed": String(!project), onclick: () => app.open("board", {}) }, "все"),
        ...all.map((x) => h("button", { "aria-pressed": String(project === x.name), "data-project": x.name, onclick: () => app.open("board", { project: x.name }) }, x.name, h("i", null, String(x.sessions.filter(inProject).length)))),
      );
      body.textContent = "";
      const shown = project ? all.filter((x) => x.name === project) : all;
      let outside = 0;
      for (const x of shown) {
        const pm = machinesOf(x.name);
        const ss = x.sessions.filter((s) => pm.includes(machineOf(s.callsign) ?? ""));
        outside += x.sessions.length - ss.length;
        if (!ss.length) continue;
        if (!project) body.append(h("div", { class: "bd-proj", "data-proj": x.name }, x.name, h("span", null, `${ss.length} · ${pm.filter((m) => ss.some((s) => machineOf(s.callsign) === m)).join(", ")}`)));
        const keys = group === "machine" ? pm.filter((m) => ss.some((s) => machineOf(s.callsign) === m)) : [...new Set(ss.map(profOf))].sort();
        for (const k of keys) {
          const inG = ss.filter((s) => (group === "machine" ? machineOf(s.callsign) : profOf(s)) === k);
          body.append(
            h(
              "div",
              { class: "bd-grp", "data-group": k },
              group === "machine" ? [h("span", { class: "sb-dot idle" }), h("span", { class: "m" }, `@${k}`)] : h("span", { class: "p" }, k),
              h("span", null, String(inG.length)),
            ),
          );
          for (const [s, d] of tree(inG)) body.append(row(s, d, email));
        }
      }
      if (!body.childElementCount) body.append(h("div", { class: "bd-empty" }, onlyMine ? "Ваших сессий нет" : "Сессий нет"));
      const foreign = onlyMine ? sessions().filter((s) => (!project || projectOf(s) === project) && !whyMine(s, email)).length : 0;
      if (foreign) body.append(h("div", { class: "bd-more", "data-foreign": "1" }, `Ещё ${foreign} — чужие сессии`, h("button", { onclick: () => ((onlyMine = false), draw()) }, "Всё")));
      if (outside) {
        body.append(
          h(
            "div",
            { class: "bd-more", "data-outside": String(outside) },
            `Ещё ${outside} вне машин проекта`,
            project ? h("button", { onclick: () => el.append(focusDialog(project, draw)) }, "машины проекта") : null,
          ),
        );
      }
    }
    draw();
    redraws.add(draw);
    return {
      head: () => {
        const n = sessions().length;
        return { title: project ?? "Работа", sub: `${n} ${plural(n, "сессия", "сессии", "сессий")}` };
      },
      refresh: draw,
      close: () => redraws.delete(draw),
    };
  }

  /** Лампы проекта в колонке разделов: тоны сессий на машинах проекта. */
  const dot = (s: SessionRecord) => (s.state === "failed" ? "bad" : stateLabel(s.state).dot || "stop");

  return {
    on: {
      roster(_r: Roster) {
        /* список перерисует ядро; своё ничего не держит */
      },
    },
    screens: {
      // пункт меню карточки: переключает закрепление этой сессии и возвращает к карточке
      "board.pin": {
        place: "card.menu",
        label: "Закрепить в «Моём» / открепить",
        path: "pin",
        show: (p) => !!p.callsign,
        mount: (_el, p) => {
          if (!p.from) return;
          void togglePin(p.from).then((on) => app.toast(`${p.from} ${on ? "закреплена в «Моём»" : "откреплена"}`, "ok"));
          app.back();
        },
      },
      board: {
        nav: "Работа",
        label: "Работа",
        path: "sessions",
        mount: mountBoard,
        sub: () =>
          projects(true)
            .map((x) => ({ x, ss: x.sessions.filter(inProject) }))
            .filter(({ ss }) => ss.length)
            .map(({ x, ss }) => ({ label: x.name, params: { project: x.name }, dots: ss.map(dot) })),
        find: (q) => {
          const out: Array<{ label: string; hint?: string; dot?: string; screen: string; params?: Params }> = [];
          for (const x of projects(false)) if (!q || x.name.includes(q)) out.push({ label: x.name, hint: `проект · ${x.sessions.length} ${plural(x.sessions.length, "сессия", "сессии", "сессий")}`, screen: "board", params: { project: x.name } });
          for (const s of sessions()) {
            if (q && !`${s.callsign} ${projectOf(s)}`.toLowerCase().includes(q)) continue;
            out.push({ label: s.callsign, hint: `${projectOf(s)} · ${SHORT[String(s.state)] ?? s.state}`, dot: dot(s), screen: "board", params: { project: projectOf(s), callsign: s.callsign } });
          }
          return out;
        },
      },
    },
    marks: {
      /** почему сессия моя; не моя — "" */
      mine: (callsign: string) => {
        const s = sessions().find((x) => x.callsign === callsign);
        return s ? whyMine(s) : "";
      },
      /** проект сессии */
      project: (callsign: string) => {
        const s = sessions().find((x) => x.callsign === callsign);
        return s ? projectOf(s) : null;
      },
      /** машины проекта на этом устройстве */
      "project.machines": (project: string) => machinesOf(project),
      /** последний открытый проект */
      "project.current": () => {
        const c = app?.current();
        return (c?.screen === "board" ? c.params.project : null) ?? lastProject;
      },
    },
    store: ["projects", "pins"],
    css: CSS,
    async start(a) {
      app = a;
      chosen = (await app.store<Record<string, string[]>>("projects").get()) ?? {};
      pins = (await app.store<string[]>("pins").get()) ?? [];
    },
  };
}
