// pult-incidents — инциденты: сессии с полем roster incident и недоставленные обращения из журнала машины.
// Своего хранилища нет: сессии — из roster, недоставленные — ответ machine.journal; текст отказа — как записал Host.
import { h, hhmm, stateLabel, type App, type AppModule, type Roster, type ScreenHandle, type SessionRecord } from "@switchboard/web-core";
import { machineOf } from "@switchboard/protocol";

type Rec = { t: string; kind?: string; ev?: string; word?: string; why?: string; id?: string; callsign?: string };
type Lost = { machine: string; id: string; word: string; why: string; t: string };
type Inc = { type: string; key?: string };

const CSS = `
.in-cap{display:flex;align-items:center;gap:7px;font:600 12px var(--body);color:var(--muted);padding:10px 2px 4px}
.in-list{display:flex;flex-direction:column;gap:6px}
.in-row{display:flex;gap:10px;align-items:flex-start;width:100%;text-align:left;border:1px solid var(--line2);background:var(--surface);border-radius:10px;padding:9px 12px;font:inherit;color:inherit}
.in-row:hover{border-color:var(--line)}
.in-row .sb-dot{margin-top:5px;flex:none}
.in-row .g{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.in-row .t1{display:flex;gap:8px;align-items:baseline;min-width:0}
.in-row .t1 b{font-weight:600}
.in-row .k{font:500 12px var(--mono);color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.in-row .s{margin-left:auto;font-size:12.5px;color:var(--muted);white-space:nowrap}
.in-row .s.bad{color:var(--bad)}
.in-row .t2{font-size:12.5px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.in-row .t2 .m{font-family:var(--mono)}
.in-lost{border-color:var(--bad)}
.in-why{background:var(--bad-weak);color:var(--ink);border-radius:8px;padding:8px 10px;font-size:13px;overflow-wrap:anywhere}
`;

const incOf = (s: SessionRecord): Inc | null => {
  const x = s.incident as Inc | undefined;
  return x && typeof x.type === "string" ? x : null;
};
const open = (s: SessionRecord) => s.state !== "stopped";

/** Полночь сегодня по местному времени — since журнала машины. */
function midnight(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

/** Новый модуль со своей памятью (в выпуске — один; в тестах — на каждый прогон). */
export function createIncidents(): AppModule {
  let app: App;
  /** недоставленные по машинам: последняя строка отказа на обращение */
  const lost = new Map<string, Lost[]>();
  const refused = new Map<string, string>();
  /** машины, чей журнал уже прочитан: новая в roster — дочитать её */
  const asked = new Set<string>();
  const screens = new Set<() => void>();
  const redraw = () => {
    screens.forEach((d) => d());
    app.changed();
  };

  /** Машины с инцидентами и журналом. */
  const machines = () => (app.roster()?.machines ?? []).filter((m) => m.contract?.incident !== undefined && m.contract?.["machine.journal"] !== undefined).map((m) => m.machine);

  async function loadLost(only?: string[]) {
    await Promise.all(
      (only ?? machines()).map(async (m) => {
        asked.add(m);
        const r = await app.request<{ records: Rec[]; more: boolean }>("machine.journal", { machine: m, since: midnight(), kind: ["refuse"], limit: 200 });
        if (!r.ok) return void refused.set(m, r.error);
        refused.delete(m);
        const byId = new Map<string, Lost>();
        for (const x of r.result.records) if (x.ev === "incident" && x.id) byId.set(x.id, { machine: m, id: x.id, word: x.word ?? "", why: x.why ?? "", t: x.t });
        lost.set(m, [...byId.values()].reverse());
      }),
    );
    redraw();
  }

  const sessions = () => (app.roster()?.sessions ?? []).filter((s) => incOf(s));
  const allLost = () => [...lost.values()].flat();

  function mount(el: HTMLElement): ScreenHandle {
    const box = h("div", { class: "sb-page" });
    el.append(box);
    let all = false;
    let picked = "";

    function draw() {
      box.textContent = "";
      const ss = sessions().filter((s) => all || open(s));
      const lo = allLost();
      box.append(
        h(
          "div",
          { class: "sb-ph" },
          app.wide ? h("h2", null, "Инциденты") : null,
          h("button", { class: "sb-b", "data-f": "open", "aria-pressed": all ? "false" : "true", onclick: () => ((all = false), draw()) }, "открытые"),
          h("button", { class: "sb-b", "data-f": "all", "aria-pressed": all ? "true" : "false", onclick: () => ((all = true), draw()) }, "все"),
        ),
      );
      if (lo.length) {
        box.append(
          h("div", { class: "in-cap" }, h("span", { class: "sb-dot bad" }), "Не доставлены"),
          h(
            "div",
            { class: "in-list" },
            lo.flatMap((x) => {
              const k = `${x.machine}:${x.id}`;
              const row = h(
                "button",
                { class: "in-row in-lost", "data-lost": k, "aria-expanded": picked === k ? "true" : "false", onclick: () => ((picked = picked === k ? "" : k), draw()) },
                h("span", { class: "sb-dot bad" }),
                h("span", { class: "g" }, h("span", { class: "t1" }, h("b", null, `@${x.machine}`), h("span", { class: "s bad" }, x.word)), h("span", { class: "t2" }, `с ${hhmm(new Date(x.t))}`)),
              );
              return picked === k ? [row, h("div", { class: "in-why", "data-why": k }, x.why || x.word)] : [row];
            }),
          ),
        );
      }
      for (const [m, w] of refused) box.append(h("div", { class: "sb-note bad", role: "alert" }, `${m} · machine.journal: ${w}`));
      box.append(h("div", { class: "in-cap" }, "В сессиях"));
      if (!ss.length) box.append(h("div", { class: "sb-note" }, all ? "Инцидентов нет" : "Открытых инцидентов нет"));
      else
        box.append(
          h(
            "div",
            { class: "in-list" },
            ss.map((s) => {
              const inc = incOf(s)!;
              const st = s.state === "stopped" ? { text: "закрыт", dot: "stop" } : stateLabel(s.state);
              return h(
                "button",
                { class: "in-row", "data-incident": s.callsign, onclick: () => app.open("card", { callsign: s.callsign }) },
                h("span", { class: `sb-dot ${st.dot}` }),
                h(
                  "span",
                  { class: "g" },
                  h("span", { class: "t1" }, h("b", null, inc.type), inc.key !== undefined ? h("span", { class: "k" }, String(inc.key)) : null, h("span", { class: "s" }, st.text)),
                  h("span", { class: "t2" }, h("span", { class: "m" }, s.callsign), ` · @${machineOf(s.callsign)}`),
                ),
              );
            }),
          ),
        );
    }

    screens.add(draw);
    draw();
    void loadLost();
    return { head: () => ({ title: "Инциденты" }), close: () => screens.delete(draw) };
  }

  return {
    on: {
      roster(_r: Roster) {
        // машина впервые в roster — её недоставленные для метки раздела; заново — при открытии экрана
        const fresh = machines().filter((m) => !asked.has(m));
        if (fresh.length) void loadLost(fresh);
        screens.forEach((d) => d());
      },
    },
    screens: {
      incidents: {
        nav: "Инциденты",
        mark: "incidents.open",
        label: "Инциденты",
        mount,
        find: (q) =>
          sessions()
            .filter((s) => !q || `${incOf(s)!.type} ${incOf(s)!.key ?? ""} ${s.callsign}`.toLowerCase().includes(q))
            .map((s) => ({ label: `${incOf(s)!.type} · ${s.callsign}`, hint: "инцидент", dot: stateLabel(s.state).dot, screen: "incidents", params: {} })),
      },
    },
    marks: {
      "incidents.open": () => sessions().filter(open).length + allLost().length,
    },
    css: CSS,
    start(a) {
      app = a;
    },
  };
}

