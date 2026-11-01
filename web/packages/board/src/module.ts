// web-board — список сессий всех машин из roster: состояние и одна строка — модель и слот,
// вопрос (метка asked модуля ask) или последнее сообщение (метка unread модуля chat).
// Дочь — под родителем (поле parent), сессия инцидента — со значком типа (поле incident).
// Машины, ушедшие при открытом приложении, — серыми из последнего roster, который видел список.
import { add, h, hhmm, plural, sessionLine, stateLabel, type App, type AppModule, type Roster, type ScreenHandle, type SessionRecord } from "@switchboard/web-core";
import { kindOf, machineOf } from "@switchboard/protocol";

const CSS = `
.board{gap:7px}
.board-mach{display:flex;justify-content:space-between;align-items:baseline;gap:8px;padding:8px 4px 0;font:600 12px/1.3 var(--mono);letter-spacing:.1em;text-transform:uppercase;color:var(--muted)}
.board-mach em{font:500 12px/1.3 var(--mono);letter-spacing:0;text-transform:none;font-style:normal}
.board-mach.off em{color:var(--bad)}
.board-row{display:grid;grid-template-columns:10px minmax(0,1fr) auto;gap:12px;align-items:center;width:100%;text-align:left;padding:12px 14px;border-radius:16px;background:var(--surface);border:1px solid var(--line2)}
.board-row:hover{border-color:var(--accent)}
.board-row.off{opacity:.5}
.board-rt{display:flex;flex-direction:column;min-width:0;gap:1px}
.board-rt b{font:600 14.5px/1.3 var(--mono)}
.board-rt span{font-size:13.5px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.board-hint{font-size:12.5px;color:var(--muted);text-align:center;margin-top:auto;padding:12px 0 calc(12px + env(safe-area-inset-bottom,0px))}
.board-empty{color:var(--muted);text-align:center;padding:40px 12px}
/* широкий вид: список с поиском слева, сводка справа; рядом с карточкой — только список */
.board-wide{flex:1;min-height:0;display:grid;grid-template-columns:minmax(260px,320px) minmax(0,1fr)}
.sb-master .board-wide{grid-template-columns:minmax(0,1fr)}
.sb-master .board-sum{display:none}
.board-list{display:flex;flex-direction:column;min-height:0;background:var(--surface);border-right:1px solid var(--line2)}
.sb-master .board-list{border-right:0}
.board-lh{display:flex;align-items:baseline;justify-content:space-between;gap:8px;padding:14px 14px 8px}
.board-lh b{font:600 17px var(--body)}
.board-lh span{font:500 12px var(--mono);color:var(--muted)}
.board-q{margin:0 12px;border:1px solid var(--line);border-radius:9px;padding:7px 10px;font:13.5px var(--body);color:var(--ink);background:var(--bg)}
.board-seg{display:flex;gap:2px;margin:8px 12px 2px;padding:2px;background:var(--surface2);border-radius:9px}
.board-seg button{flex:1;border:0;background:none;border-radius:7px;padding:5px 4px;font:12.5px var(--body);color:var(--muted);white-space:nowrap}
.board-seg button[aria-pressed="true"]{background:var(--surface);color:var(--ink);font-weight:600;box-shadow:var(--shadow)}
.board-seg i{font:700 11px var(--mono);font-style:normal;margin-left:4px;color:var(--wait)}
.board-off{margin:8px 12px 0;background:var(--bad-weak);color:var(--bad);border-radius:9px;padding:7px 10px;font-size:12.5px}
.board-groups{flex:1;min-height:0;overflow-y:auto;padding:0 8px 10px}
.board-gh{display:flex;justify-content:space-between;font:600 10.5px var(--mono);letter-spacing:.1em;text-transform:uppercase;color:var(--muted);padding:10px 6px 3px}
.board-gh.need{color:var(--wait)}
.board-wr{display:grid;grid-template-columns:10px minmax(0,1fr) auto;gap:1px 9px;align-items:center;width:100%;text-align:left;padding:7px 9px;border-radius:10px;border:1px solid transparent;background:transparent}
.board-wr:hover{border-color:var(--line)}
.board-wr[aria-current="true"]{background:var(--accent-weak)}
.board-wr.off{opacity:.45}
.board-wr .sb-dot{width:8px;height:8px}
.board-wr b{font:600 13px var(--mono);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.board-wr .t{font:600 11.5px var(--body);white-space:nowrap;color:var(--muted)}
.board-wr .t.wait{color:var(--wait)}
.board-wr .t.bad{color:var(--bad)}
.board-wr .t.busy{color:var(--accent)}
.board-wr .t.ok{color:var(--ok)}
.board-wr .m{grid-column:2 / 4;font-size:12px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.board-wr .m.ask{color:var(--ink)}
.board-sum{overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:12px}
.board-tiles{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}
.board-tile{background:var(--surface);border:1px solid var(--line2);border-radius:12px;padding:10px 13px;display:flex;flex-direction:column;gap:2px}
.board-tile b{font:700 24px/1.1 var(--disp)}
.board-tile span{font-size:12.5px;color:var(--muted);display:flex;align-items:center;gap:6px}
.board-tile .sb-dot{width:8px;height:8px}
.board-panel{background:var(--surface);border:1px solid var(--line2);border-radius:12px;padding:11px 13px;display:flex;flex-direction:column;gap:7px}
.board-h4{margin:0;font:600 10.5px var(--mono);letter-spacing:.1em;text-transform:uppercase;color:var(--muted)}
.board-slot{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr) 30px;gap:8px;font-size:13px}
.board-slot span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.board-slot em{font:600 12px var(--mono);font-style:normal;text-align:right}
.board-pick{color:var(--muted);text-align:center;padding:30px 0}
.board-inc{font:600 10.5px var(--mono);font-style:normal;color:var(--wait);background:var(--wait-weak);border-radius:6px;padding:1px 6px;margin-left:6px;letter-spacing:0}
@media (max-width:760px){.board-wide{grid-template-columns:minmax(0,1fr)}.board-sum{display:none}}
`;

/** Короткая подпись состояния в строке списка. */
const SHORT: Record<string, string> = { busy: "работает", waiting: "ждёт", idle: "простаивает", stopped: "стоп", failed: "сбой", starting: "поднимается", stopping: "стоп…" };
/** Прошедшее время — для сессий ушедшей машины. */
const PAST: Record<string, string> = { busy: "работала", waiting: "ждала ответа", idle: "простаивала", stopped: "остановлена", failed: "сбой" };
/** Широкий вид: группы по тому, что нужно от человека. */
const GROUPS: Array<[string, (s: SessionRecord) => boolean]> = [
  ["нужны вы", (s) => s.state === "waiting" || s.state === "failed"],
  ["в работе", (s) => s.state === "busy" || s.state === "starting"],
  ["свободны", (s) => s.state === "idle"],
  ["остановлены", (s) => s.state === "stopped" || s.state === "stopping"],
];

type Gone = { at: number; sessions: SessionRecord[] };

/** Широкий вид: подпись состояния в строке и её цвет. */
const WIDE: Record<string, [string, string]> = {
  busy: ["отвечает", "busy"],
  waiting: ["ждёт ответа", "wait"],
  failed: ["не поднялась", "bad"],
  idle: ["свободна", "ok"],
  starting: ["запускается", "busy"],
  stopping: ["останавливается", ""],
  stopped: ["остановлена", ""],
};
const slotOf = (s: SessionRecord) => (s.slot as { name?: string } | null | undefined)?.name;
const profileOf = (s: SessionRecord) => (s.profile as { id?: string } | null | undefined)?.id;
/** Строка широкого вида: машина · слот · аккаунт · модель · усилие · профиль. */
const wideLine = (s: SessionRecord) =>
  [machineOf(s.callsign), slotOf(s), s.account, s.model, s.effort, profileOf(s)?.split("/").at(-1)].filter((x) => typeof x === "string" && x).join(" · ");

/** Родитель-сессия из поля parent; устройство и машина — не родитель для дерева. */
const parentOf = (s: SessionRecord) => (typeof s.parent === "string" && kindOf(s.parent) === "session" && s.parent !== s.callsign ? s.parent : null);
const incidentOf = (s: SessionRecord) => (s.incident as { type?: string } | null | undefined)?.type;

/** Порядок дерева: дочь сразу под родителем, глубина — отступ; родителя нет в списке — дочь в корне. */
export function tree(list: SessionRecord[]): Array<[SessionRecord, number]> {
  const here = new Set(list.map((s) => s.callsign));
  const kids = new Map<string, SessionRecord[]>();
  const roots: SessionRecord[] = [];
  for (const s of list) {
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

/** Позывной строки и значок типа инцидента. */
const title = (s: SessionRecord) => h("b", null, s.callsign, incidentOf(s) ? h("i", { class: "board-inc" }, incidentOf(s)!) : null);

/** Новый модуль со своей памятью (в выпуске — один; в тестах — на каждый прогон). */
export function createBoard(): AppModule {
  let app: App;
  let last: Roster | null = null;
  const gone = new Map<string, Gone>();
  /** поиск и фильтр широкого вида — память модуля: список переживает переход к карточке */
  let query = "";
  let filter: "all" | "need" | "busy" = "all";

  function onRoster(r: Roster) {
    const now = new Set(r.machines.map((m) => m.machine));
    for (const m of now) gone.delete(m);
    for (const m of last?.machines ?? []) {
      if (!now.has(m.machine)) gone.set(m.machine, { at: Date.now(), sessions: last!.sessions.filter((s) => machineOf(s.callsign) === m.machine) });
    }
    last = r;
  }

  const need = () => (app?.roster()?.sessions ?? []).filter((s) => s.state === "waiting" || s.state === "failed").length;

  function row(s: SessionRecord, off: boolean, depth = 0): HTMLElement {
    const st = stateLabel(s.state);
    const asked = off ? undefined : (app.mark("asked", s.callsign) as string | undefined);
    const unread = off ? undefined : (app.mark("unread", s.callsign) as { count: number; text: string } | undefined);
    let line = sessionLine(s);
    if (off) line = `последнее: ${PAST[String(s.state)] ?? s.state}`;
    else if (asked) line = asked;
    else if (unread?.text) line = unread.text;
    else if (s.state === "stopped") line = "остановлена";
    else if (s.state === "failed" && s.failed) line = Object.entries(s.failed as Record<string, string>).map(([k, v]) => `${k}: ${v}`).join("; ");
    // родитель не над строкой (на другой машине) — его позывной в строке
    if (!off && !depth && parentOf(s)) line = `↳ ${parentOf(s)} · ${line}`;
    const right = asked
      ? h("span", { class: "sb-badge wait", "aria-label": "ждёт ответа" }, "?")
      : unread
        ? h("span", { class: "sb-badge", "aria-label": `непрочитанных ${unread.count}` }, unread.count)
        : off
          ? null
          : h("span", { class: `sb-pill ${st.tone}` }, SHORT[String(s.state)] ?? st.text);
    return h(
      "button",
      {
        class: "board-row" + (off ? " off" : "") + (depth ? " kid" : ""),
        "data-callsign": s.callsign,
        style: depth ? `margin-left:${depth * 18}px` : null,
        onclick: () => (asked ? app.open("ask", { callsign: s.callsign }) : app.open("card", { callsign: s.callsign })),
      },
      h("span", { class: `sb-dot ${off ? "" : st.dot}` }),
      h("span", { class: "board-rt" }, title(s), h("span", null, line)),
      right,
    );
  }

  /** Строка широкого вида: позывной, состояние, вопрос или машина · слот · аккаунт · модель. */
  function wideRow(s: SessionRecord, off: boolean, depth = 0): HTMLElement {
    const [label, tone] = off ? ["не на связи", ""] : (WIDE[String(s.state)] ?? [String(s.state ?? "—"), ""]);
    const asked = off ? undefined : (app.mark("asked", s.callsign) as string | undefined);
    const sel = app.current()?.params.callsign === s.callsign;
    return h(
      "button",
      {
        class: "board-wr" + (off ? " off" : "") + (depth ? " kid" : ""),
        "data-callsign": s.callsign,
        "aria-current": sel ? "true" : "false",
        style: depth ? `margin-left:${depth * 14}px` : null,
        onclick: () => app.open("card", { callsign: s.callsign }),
      },
      h("span", { class: `sb-dot ${off ? "" : stateLabel(s.state).dot}` }),
      title(s),
      h("span", { class: `t ${tone}` }, label),
      h("span", { class: "m" + (asked ? " ask" : "") }, asked ? `? ${asked}` : !depth && parentOf(s) ? `↳ ${parentOf(s)} · ${wideLine(s)}` : wideLine(s)),
    );
  }

  /** Широкий вид: поиск, фильтр и группы слева, сводка справа (рядом с карточкой сводка скрыта). */
  function mountWide(el: HTMLElement): ScreenHandle {
    const q = h("input", { class: "board-q", type: "search", placeholder: "⌕ позывной, машина, слот, профиль…", "aria-label": "Поиск сессий", value: query }) as HTMLInputElement;
    q.addEventListener("input", () => {
      query = q.value;
      draw();
    });
    const seg = h("div", { class: "board-seg", role: "group" });
    const off = h("div", { class: "board-off", role: "status" });
    const groups = h("div", { class: "board-groups" });
    const count = h("span");
    const sum = h("div", { class: "board-sum" });
    el.append(h("div", { class: "board-wide" }, h("div", { class: "board-list" }, h("div", { class: "board-lh" }, h("b", null, "Сессии"), count), q, seg, off, groups), sum));
    const hit = (s: SessionRecord) => {
      const t = query.trim().toLowerCase();
      return !t || [s.callsign, slotOf(s), s.account, profileOf(s), s.model].some((x) => typeof x === "string" && x.toLowerCase().includes(t));
    };
    function draw() {
      const r = app.roster();
      if (!r) return;
      const all = r.sessions;
      const needs = all.filter(GROUPS[0][1]).length;
      const busy = all.filter((s) => s.state === "busy").length;
      count.textContent = `${all.length} ${plural(all.length, "сессия", "сессии", "сессий")}`;
      seg.textContent = "";
      for (const [k, label, n] of [["all", "Все", all.length], ["need", "Нужны вы", needs], ["busy", "Отвечают", busy]] as const) {
        seg.append(h("button", { "aria-pressed": filter === k ? "true" : "false", "data-filter": k, onclick: () => ((filter = k), draw()) }, label, h("i", null, String(n))));
      }
      off.hidden = !gone.size;
      off.textContent = [...gone].map(([m, g]) => `${m} не на связи с ${hhmm(g.at)} — её сессии серые, отправка им — отказ`).join(" · ");
      groups.textContent = "";
      const pass = (s: SessionRecord) => hit(s) && (filter === "all" || (filter === "need" ? GROUPS[0][1](s) : s.state === "busy"));
      for (const [title, fit] of GROUPS) {
        const list = all.filter(fit).filter(pass);
        if (!list.length) continue;
        groups.append(h("div", { class: "board-mach board-gh" + (title === "нужны вы" ? " need" : "") }, title, h("em", null, String(list.length))));
        for (const [s, d] of tree(list)) groups.append(wideRow(s, false, d));
      }
      for (const [m, g] of gone) {
        const list = g.sessions.filter(hit);
        if (!list.length) continue;
        groups.append(h("div", { class: "board-gh" }, m, h("em", null, "не на связи")));
        for (const s of list) groups.append(wideRow(s, true));
      }
      if (!all.length && !gone.size) groups.append(h("div", { class: "board-empty" }, "Сессий нет"));
      // сводка: плитки по группам и слоты — поля slot и account из roster; лимиты — раздел «Аккаунты»
      sum.textContent = "";
      const tiles = GROUPS.map(([title, fit], i) =>
        h("div", { class: "board-tile" }, h("b", null, String(all.filter(fit).length)), h("span", null, h("span", { class: `sb-dot ${["wait", "busy", "idle", "stop"][i]}` }), title === "в работе" ? "отвечают" : title)),
      );
      const slots = new Map<string, string[]>();
      for (const s of all) {
        if (!slotOf(s)) continue;
        const k = [machineOf(s.callsign), slotOf(s), s.account].filter(Boolean).join(" · ");
        slots.set(k, [...(slots.get(k) ?? []), s.callsign.split("@")[0]]);
      }
      add(
        sum,
        h("div", { class: "board-tiles" }, tiles),
        slots.size
          ? h(
              "div",
              { class: "board-panel" },
              h("h4", { class: "board-h4" }, "слоты · поля slot и account из roster"),
              [...slots].map(([k, names]) => h("div", { class: "board-slot" }, h("span", null, k), h("span", null, names.join(", ")), h("em", null, String(names.length)))),
            )
          : null,
        h("div", { class: "board-pick" }, "Выберите сессию в списке."),
      );
    }
    draw();
    return { head: () => ({ title: "Сессии" }), refresh: draw };
  }

  function mountBoard(el: HTMLElement): ScreenHandle {
    if (app.wide) return mountWide(el);
    const body = h("div", { class: "sb-pad board" });
    el.append(body);
    function draw() {
      const r = app.roster();
      body.textContent = "";
      if (!r) return;
      for (const m of r.machines) {
        const list = r.sessions.filter((s) => machineOf(s.callsign) === m.machine);
        body.append(h("div", { class: "board-mach" }, m.machine, h("em", null, `${list.length} ${plural(list.length, "сессия", "сессии", "сессий")}`)));
        for (const [s, d] of tree(list)) body.append(row(s, false, d));
      }
      for (const [m, g] of gone) {
        body.append(h("div", { class: "board-mach off" }, m, h("em", null, `не на связи с ${hhmm(g.at)}`)));
        for (const s of g.sessions) body.append(row(s, true));
      }
      if (!r.sessions.length && !gone.size) body.append(h("div", { class: "board-empty" }, "Сессий нет"));
      const others = r.clients.filter((c) => c !== app.name);
      body.append(h("div", { class: "board-hint" }, `Флот смотрят: вы${others.length ? " и " + others.join(", ") : ""}`));
    }
    draw();
    return {
      head: () => {
        const r = app.roster();
        const on = r?.machines.length ?? 0;
        const all = on + gone.size;
        const n = r?.sessions.length ?? 0;
        const machines = gone.size ? `${on} ${plural(on, "машина", "машины", "машин")} из ${all}` : `${on} ${plural(on, "машина", "машины", "машин")}`;
        return { title: "Флот", sub: `${machines} · ${n} ${plural(n, "сессия", "сессии", "сессий")}` };
      },
      refresh: draw,
    };
  }

  return {
    on: { roster: onRoster },
    screens: { board: { nav: "Сессии", mark: "need", label: "Список", path: "sessions", mount: mountBoard } },
    marks: { need },
    css: CSS,
    start(a) {
      app = a;
    },
  };
}
