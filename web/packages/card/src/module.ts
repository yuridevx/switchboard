// web-card — карточка сессии: шапка из roster, вкладки «Чат» (экран chat в месте карточки)
// и «Сведения» (поля roster как прислали владельцы; остановить и поднять — если они есть в contract машины).
// Широкий вид (пульт) — src/wide.ts: плашка состояния, «Настройки», «Журнал машины» и вкладки выпуска.
import { h, sessionLine, stateLabel, type App, type AppModule, type ScreenHandle, type SessionRecord } from "@switchboard/web-core";
import { machineOf } from "@switchboard/protocol";
import { mountWide, WIDE_CSS, type CardTab } from "./wide.ts";

export type { CardTab };

const CSS = `
.card-tabs{flex:none;display:flex;gap:4px;padding:6px 10px;background:var(--surface);border-bottom:1px solid var(--line2)}
.card-tabs button{border:0;background:transparent;border-radius:9px;padding:7px 12px;font:600 14px var(--body);color:var(--muted)}
.card-tabs button[aria-selected="true"]{background:var(--accent-weak);color:var(--accent)}
.card-place{flex:1;min-height:0;display:flex;flex-direction:column}
.card-info{display:grid;grid-template-columns:auto minmax(0,1fr);gap:8px 14px;background:var(--surface);border:1px solid var(--line2);border-radius:14px;padding:12px 14px;font-size:14px}
.card-info dt{color:var(--muted)}
.card-info dd{margin:0;font-family:var(--mono);overflow-wrap:anywhere}
.card-act{width:100%;background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:11px;font:600 15px var(--body)}
`;

/** Новый модуль со своей памятью (в выпуске — один; в тестах — на каждый прогон). */
export function createCard(o: { tabs?: CardTab[] } = {}): AppModule {
  let app: App;

  function mountCard(el: HTMLElement, params: Record<string, string>): ScreenHandle {
    if (app.wide) return mountWide(app, el, params, o.tabs ?? []);
    const callsign = params.callsign ?? "";
    let tab: "chat" | "info" = params.tab === "info" ? "info" : "chat";
    let inner: ScreenHandle | undefined;
    let busy = "";
    let error = "";
    const tabs = h("div", { class: "card-tabs", role: "tablist" });
    const place = h("div", { class: "card-place" });
    el.append(tabs, place);

    const session = (): SessionRecord | undefined => app.roster()?.sessions.find((s) => s.callsign === callsign);
    const can = (name: string) => {
      const m = machineOf(callsign);
      return !!m && app.provides(m)?.[name] !== undefined;
    };

    async function act(name: "session.stop" | "session.start") {
      busy = name;
      error = "";
      draw();
      const r = await app.request(name, { callsign });
      busy = "";
      if (!r.ok) error = `${name}: ${r.error}`;
      draw();
    }

    function info(): HTMLElement {
      const s = session();
      const rows: Array<[string, unknown]> = s
        ? [
            ["состояние", stateLabel(s.state).text],
            ["модель", s.model],
            ["усилие", s.effort],
            ["слот", (s.slot as { name?: string } | undefined)?.name],
            ["аккаунт", s.account],
            ["профиль", (s.profile as { id?: string } | null | undefined)?.id],
            ["сбой", s.failed ? Object.entries(s.failed as Record<string, string>).map(([k, v]) => `${k}: ${v}`).join("; ") : undefined],
          ]
        : [["состояние", `${machineOf(callsign)} не на связи`]];
      const remote = typeof s?.remote === "string" ? s.remote : (s?.remote as { url?: string } | undefined)?.url;
      const stopped = s?.state === "stopped";
      return h(
        "div",
        { class: "sb-pad" },
        h("dl", { class: "card-info" }, rows.filter(([, v]) => v !== undefined && v !== null && v !== "").flatMap(([k, v]) => [h("dt", null, k), h("dd", null, String(v))])),
        remote ? h("a", { class: "card-act", href: remote, target: "_blank", rel: "noopener" }, "Открыть в claude.ai") : null,
        s && !stopped && can("session.stop") ? h("button", { class: "card-act", disabled: !!busy, onclick: () => act("session.stop") }, busy === "session.stop" ? "Останавливаю…" : "Остановить") : null,
        s && stopped && can("session.start") ? h("button", { class: "card-act", disabled: !!busy, onclick: () => act("session.start") }, busy === "session.start" ? "Поднимаю…" : "Поднять") : null,
        error ? h("div", { class: "sb-badc", role: "alert" }, h("b", null, "Не вышло"), h("code", null, error)) : null,
      );
    }

    function draw() {
      tabs.textContent = "";
      for (const [k, label] of [["chat", "Чат"], ["info", "Сведения"]] as const) {
        tabs.append(h("button", { role: "tab", "aria-selected": tab === k ? "true" : "false", onclick: () => select(k) }, label));
      }
      if (tab === "info") {
        place.textContent = "";
        place.append(info());
      } else if (!inner) inner = app.open("chat", { callsign }, place);
    }

    function select(k: "chat" | "info") {
      if (k === tab) return;
      tab = k;
      inner?.close?.();
      inner = undefined;
      place.textContent = "";
      draw();
    }

    draw();
    return {
      head: () => {
        const s = session();
        if (!s) return { title: callsign, mono: true, sub: `${machineOf(callsign)} не на связи` };
        const st = stateLabel(s.state);
        return { title: callsign, mono: true, sub: sessionLine(s, true), pill: { text: st.text, tone: st.tone } };
      },
      refresh: () => {
        if (tab === "info") draw();
      },
      close: () => inner?.close?.(),
    };
  }

  return {
    screens: { card: { label: "Карточка", mount: mountCard } },
    css: CSS + WIDE_CSS,
    start(a) {
      app = a;
    },
  };
}
