// web-board — список сессий всех машин из roster: состояние и одна строка — модель и слот,
// вопрос (метка asked модуля ask) или последнее сообщение (метка unread модуля chat).
// Машины, ушедшие при открытом приложении, — серыми из последнего roster, который видел список.
import { h, hhmm, plural, sessionLine, stateLabel, type App, type AppModule, type Roster, type ScreenHandle, type SessionRecord } from "@switchboard/web-core";
import { machineOf } from "@switchboard/protocol";

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

/** Новый модуль со своей памятью (в выпуске — один; в тестах — на каждый прогон). */
export function createBoard(): AppModule {
  let app: App;
  let last: Roster | null = null;
  const gone = new Map<string, Gone>();

  function onRoster(r: Roster) {
    const now = new Set(r.machines.map((m) => m.machine));
    for (const m of now) gone.delete(m);
    for (const m of last?.machines ?? []) {
      if (!now.has(m.machine)) gone.set(m.machine, { at: Date.now(), sessions: last!.sessions.filter((s) => machineOf(s.callsign) === m.machine) });
    }
    last = r;
  }

  const need = () => (app?.roster()?.sessions ?? []).filter((s) => s.state === "waiting" || s.state === "failed").length;

  function row(s: SessionRecord, off: boolean): HTMLElement {
    const st = stateLabel(s.state);
    const asked = off ? undefined : (app.mark("asked", s.callsign) as string | undefined);
    const unread = off ? undefined : (app.mark("unread", s.callsign) as { count: number; text: string } | undefined);
    let line = sessionLine(s);
    if (off) line = `последнее: ${PAST[String(s.state)] ?? s.state}`;
    else if (asked) line = asked;
    else if (unread?.text) line = unread.text;
    else if (s.state === "stopped") line = "остановлена";
    else if (s.state === "failed" && s.failed) line = Object.entries(s.failed as Record<string, string>).map(([k, v]) => `${k}: ${v}`).join("; ");
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
        class: "board-row" + (off ? " off" : ""),
        "data-callsign": s.callsign,
        onclick: () => (asked ? app.open("ask", { callsign: s.callsign }) : app.open("card", { callsign: s.callsign })),
      },
      h("span", { class: `sb-dot ${off ? "" : st.dot}` }),
      h("span", { class: "board-rt" }, h("b", null, s.callsign), h("span", null, line)),
      right,
    );
  }

  function mountBoard(el: HTMLElement): ScreenHandle {
    const body = h("div", { class: "sb-pad board" });
    el.append(body);
    function draw() {
      const r = app.roster();
      body.textContent = "";
      if (!r) return;
      if (app.wide) {
        for (const [title, fit] of GROUPS) {
          const list = r.sessions.filter(fit);
          if (!list.length) continue;
          body.append(h("div", { class: "board-mach" }, title, h("em", null, String(list.length))));
          for (const s of list) body.append(row(s, false));
        }
      } else {
        for (const m of r.machines) {
          const list = r.sessions.filter((s) => machineOf(s.callsign) === m.machine);
          body.append(h("div", { class: "board-mach" }, m.machine, h("em", null, `${list.length} ${plural(list.length, "сессия", "сессии", "сессий")}`)));
          for (const s of list) body.append(row(s, false));
        }
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
