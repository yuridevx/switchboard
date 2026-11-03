// web-labels — человеческие имена сессий и машин: настройка пользователя (у почты, ключ web-labels.names), другие люди флота их не видят.
// Имя заменяет адрес в интерфейсе: метки label.session и label.machine; адрес в протоколе, журнале и у модели не меняется.
// Окно «Имена» — экран labels в месте вызывающего: закрылось — на месте событие sb-close.
import { h, personal, type App, type AppModule, type Params, type Personal, type ScreenHandle } from "@switchboard/web-core";
import { machineOf } from "@switchboard/protocol";

export type Shown = { text: string; human: boolean };
type Names = { sessions?: Record<string, string>; machines?: Record<string, string> };

const CSS = `
.lb-veil{position:fixed;inset:0;z-index:30;background:rgba(10,15,12,.38);display:flex;align-items:flex-start;justify-content:center;padding-top:90px}
.lb-dlg{width:min(420px,92%);background:var(--surface);border:1px solid var(--line);border-radius:14px;box-shadow:0 20px 60px rgba(0,0,0,.25);display:flex;flex-direction:column;gap:10px;padding:14px 16px}
.lb-dlg b{font:600 16px var(--body)}
.lb-a{font:400 13px var(--mono);color:var(--muted);overflow-wrap:anywhere}
.lb-f{display:flex;flex-direction:column;gap:4px;font:600 12px var(--body);color:var(--muted)}
.lb-f input{border:1px solid var(--line);border-radius:8px;padding:8px 10px;font:14px var(--body);background:var(--surface);color:var(--ink);min-width:0}
.lb-ft{display:flex;gap:8px;justify-content:flex-end;padding-top:4px}
.sb-app:not(.wide) .lb-veil{align-items:flex-end;padding-top:0}
.sb-app:not(.wide) .lb-dlg{width:100%;border-radius:18px 18px 0 0;border-width:1px 0 0;padding-bottom:calc(16px + env(safe-area-inset-bottom,0px))}
`;

/** Новый модуль со своей памятью (в выпуске — один; в тестах — на каждый прогон). */
export function createLabels(): AppModule {
  let app: App;
  let p: Personal;
  const names = () => p?.get<Names>("names") ?? {};

  function mount(el: HTMLElement, params: Params): ScreenHandle {
    const callsign = params.callsign ?? "";
    const machine = params.machine ?? machineOf(callsign) ?? "";
    const close = () => el.dispatchEvent(new CustomEvent("sb-close"));
    const session = callsign ? (h("input", { "data-f": "session", value: names().sessions?.[callsign] ?? "", placeholder: callsign.slice(0, callsign.indexOf("@")), autocomplete: "off" }) as HTMLInputElement) : null;
    const host = h("input", { "data-f": "machine", value: names().machines?.[machine] ?? "", placeholder: `@${machine}`, autocomplete: "off" }) as HTMLInputElement;
    const save = () => {
      const s = session?.value.trim() ?? "";
      const m = host.value.trim();
      p.edit<Names>("names", (old) => {
        const sessions = { ...old?.sessions };
        const machines = { ...old?.machines };
        if (callsign) {
          if (s) sessions[callsign] = s;
          else delete sessions[callsign];
        }
        if (m) machines[machine] = m;
        else delete machines[machine];
        return { sessions, machines };
      });
      close();
    };
    const keys = (e: Event) => {
      const k = e as KeyboardEvent;
      if (k.key === "Enter") save();
      if (k.key === "Escape") close();
    };
    session?.addEventListener("keydown", keys);
    host.addEventListener("keydown", keys);
    const veil = h(
      "div",
      { class: "lb-veil" },
      h(
        "div",
        { class: "lb-dlg", role: "dialog", "aria-label": "Имена" },
        h("b", null, "Имена"),
        h("div", { class: "lb-a" }, callsign || `@${machine}`),
        session ? h("label", { class: "lb-f" }, h("span", null, "Имя сессии"), session) : null,
        h("label", { class: "lb-f" }, h("span", null, "Имя машины"), host),
        h("div", { class: "lb-ft" }, h("button", { class: "sb-b", onclick: close }, "Отмена"), h("button", { class: "sb-b pri", "data-act": "save", onclick: save }, "Сохранить")),
      ),
    );
    veil.addEventListener("click", (e) => e.target === veil && close());
    el.append(veil);
    queueMicrotask(() => (session ?? host).focus());
    return {};
  }

  return {
    on: {
      link(state) {
        if (state === "open") void p.read();
      },
    },
    screens: { labels: { label: "Имена", path: "labels", mount } },
    marks: {
      "label.session": (callsign: string): Shown => {
        const name = names().sessions?.[callsign];
        return { text: name ?? callsign.slice(0, callsign.indexOf("@")), human: !!name };
      },
      "label.machine": (machine: string): Shown => {
        const name = names().machines?.[machine];
        return { text: name ?? `@${machine}`, human: !!name };
      },
    },
    css: CSS,
    start(a) {
      app = a;
      p ??= personal(app, "web-labels", () => app.changed());
    },
    async stop() {
      await p?.settled();
    },
  };
}
