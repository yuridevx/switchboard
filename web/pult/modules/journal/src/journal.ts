// pult-journal — журнал флота: записи ledger новые сверху, по дням; текст — как прислал ledger.
// Пока экран открыт, каждый roster — повод дочитать новые записи (after = последний id).
import { h, hhmm, type App, type AppModule, type ScreenHandle } from "@switchboard/web-core";

type Ev = { id: number; t: number; ev: string; from: string; by?: string; machine?: string; callsign?: string; text: string };

const CSS = `
.jr-day{font:600 11px var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--muted);padding-top:8px}
.jr-r{display:grid;grid-template-columns:52px minmax(0,1fr) auto;gap:10px;align-items:baseline;font-size:13.5px;padding:5px 0;border-bottom:1px solid var(--line2)}
.jr-r>span:first-child{font:500 12.5px var(--mono);color:var(--muted)}
.jr-r em{font:500 12px var(--mono);font-style:normal;color:var(--muted)}
.jr-r .by{color:var(--accent);font:500 12px var(--mono)}
`;

function dayOf(t: number): string {
  const d = new Date(t);
  const today = new Date();
  const yest = new Date(today.getTime() - 86_400_000);
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  return same(d, today) ? "Сегодня" : same(d, yest) ? "Вчера" : d.toLocaleDateString("ru-RU", { day: "numeric", month: "long" });
}

/** Новый модуль со своей памятью (в выпуске — один; в тестах — на каждый прогон). */
export function createJournal(): AppModule {
  let app: App;
  const screens = new Set<() => void>();

  function mount(el: HTMLElement): ScreenHandle {
    const box = h("div", { class: "sb-page" });
    el.append(box);
    let evs: Ev[] = [];
    let more = false;
    let machine = "";
    let q = "";
    let err = "";
    let reading = false;

    async function read(body: Record<string, unknown>, how: "all" | "older" | "newer") {
      reading = true;
      const r = await app.request<{ events: Ev[]; more: boolean }>("ledger.read", { limit: 50, ...(machine ? { machine } : {}), ...body });
      reading = false;
      if (!r.ok) {
        err = `ledger.read: ${r.error}`;
        return draw();
      }
      err = "";
      if (how === "all") {
        evs = r.result.events;
        more = r.result.more;
      } else if (how === "older") {
        evs = [...evs, ...r.result.events];
        more = r.result.more;
      } else {
        const known = new Set(evs.map((e) => e.id));
        evs = [...r.result.events.filter((e) => !known.has(e.id)), ...evs].sort((a, b) => b.id - a.id);
      }
      draw();
    }

    /** Новый roster — дочитать записи после последней. */
    const newer = () => {
      if (reading) return;
      if (!evs.length) return void read({}, "all");
      void read({ after: Math.max(...evs.map((e) => e.id)) }, "newer");
    };

    function draw() {
      const keep = document.activeElement instanceof HTMLInputElement && box.contains(document.activeElement) ? document.activeElement.dataset.f : undefined;
      box.textContent = "";
      const qi = h("input", { class: "sb-in", "data-f": "q", type: "search", placeholder: "⌕ поиск по записям", value: q }) as HTMLInputElement;
      qi.addEventListener("input", () => ((q = qi.value), draw()));
      const names = [...new Set([...(app.roster()?.machines ?? []).map((m) => m.machine), ...evs.map((e) => e.machine).filter((x): x is string => !!x)])].sort();
      const sel = h("select", { class: "sb-in", "data-f": "machine" }, h("option", { value: "" }, "все машины"), names.map((m) => h("option", { value: m, selected: m === machine }, m))) as HTMLSelectElement;
      sel.addEventListener("change", () => {
        machine = sel.value;
        void read({}, "all");
      });
      box.append(h("div", { class: "sb-ph" }, h("h2", null, "Журнал флота"), qi, sel));
      if (err) box.append(h("div", { class: "sb-note bad", role: "alert" }, err));
      const t = q.trim().toLowerCase();
      const shown = evs.filter((e) => !t || [e.text, e.ev, e.machine, e.callsign, e.by].some((x) => x?.toLowerCase().includes(t)));
      let last = "";
      const list = h("section", { class: "sb-sec", "data-ledger": "" });
      for (const e of shown) {
        const d = dayOf(e.t);
        if (d !== last) list.append(h("div", { class: "jr-day" }, d));
        last = d;
        list.append(
          h(
            "div",
            { class: "jr-r", "data-id": e.id },
            h("span", null, hhmm(e.t)),
            h("span", null, e.text, e.by ? h("span", { class: "by" }, ` · by ${e.by}`) : null),
            h("em", null, e.callsign ?? e.machine ?? e.from),
          ),
        );
      }
      if (!shown.length) list.append(h("div", { class: "sb-note" }, reading ? "…" : "Записей нет."));
      box.append(list);
      if (more) box.append(h("div", { class: "sb-opts" }, h("button", { class: "sb-b", onclick: () => void read({ before: Math.min(...evs.map((e) => e.id)) }, "older") }, "Раньше")));
      box.append(h("div", { class: "sb-note" }, "Текст записи пишет модуль, который это сделал; пульт показывает как есть. Сбои частей — не здесь, а в журнале машины во вкладке сессии."));
      if (keep) (box.querySelector(`[data-f="${keep}"]`) as HTMLInputElement | null)?.focus();
    }

    screens.add(newer);
    draw();
    void read({}, "all");
    return { head: () => ({ title: "Журнал флота" }), close: () => screens.delete(newer) };
  }

  return {
    on: { roster: () => screens.forEach((f) => f()) },
    screens: { journal: { nav: "Журнал флота", label: "Журнал флота", mount } },
    css: CSS,
    start(a) {
      app = a;
    },
  };
}
