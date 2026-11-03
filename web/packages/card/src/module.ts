// web-card — карточка сессии: шапка из roster, вкладки «Чат» (экран chat в месте карточки), вкладки места card.tab
// и «Сведения» (поля roster как прислали владельцы; остановить и поднять — если они есть в contract машины).
// Широкий вид (пульт) — src/wide.ts: шапка в одну строку, «Настройки», «Журнал» и вкладки места card.tab;
// «Сведения сбоку» — выбор устройства, раздел хранилища info.
import { EFFORTS, h, MODELS, projectOf, stateLabel, type App, type AppModule, type ScreenHandle, type SessionRecord } from "@switchboard/web-core";
import { machineOf } from "@switchboard/protocol";
import { HEAD0, machineName, mountWide, openNames, placedAct, sessionName, WIDE_CSS, type HeadView } from "./wide.ts";

const CSS = `
.card-pick{display:flex;flex-direction:column;gap:8px;margin:4px 0 8px}
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
export function createCard(): AppModule {
  let app: App;
  /** сведения сбоку в широкой карточке — выбор этого устройства */
  let info = false;
  /** что показывать в шапке карточки пульта — выбор этого устройства */
  let head: HeadView = { ...HEAD0 };
  const opts = {
    head: () => head,
    info: () => info,
    setInfo: (v: boolean) => {
      info = v;
      void app.store<boolean>("card.info").set(v);
    },
  };

  function mountCard(el: HTMLElement, params: Record<string, string>): ScreenHandle {
    if (app.wide) return mountWide(app, el, params, opts);
    const callsign = params.callsign ?? "";
    let tab = params.tab ?? "chat";
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

    /** модель и усилие — session.update; отказ — словом ниже */
    async function update(body: Record<string, string>) {
      busy = "session.update";
      error = "";
      draw();
      const r = await app.request("session.update", { callsign, ...body });
      busy = "";
      if (!r.ok) error = `session.update: ${r.error}`;
      draw();
    }

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
            ["адрес", callsign],
            ["папка", s.dir],
            ["слот", (s.slot as { name?: string } | undefined)?.name],
            ["аккаунт", s.account],
            ["профиль", (s.profile as { id?: string } | null | undefined)?.id],
            ["сбой", s.failed ? Object.entries(s.failed as Record<string, string>).map(([k, v]) => `${k}: ${v}`).join("; ") : undefined],
          ]
        : [["адрес", callsign]];
      const remote = typeof s?.remote === "string" ? s.remote : (s?.remote as { url?: string } | undefined)?.url;
      const stopped = s?.state === "stopped";
      return h(
        "div",
        { class: "sb-pad" },
        h("dl", { class: "card-info" }, rows.filter(([, v]) => v !== undefined && v !== null && v !== "").flatMap(([k, v]) => [h("dt", null, k), h("dd", null, String(v))])),
        s && can("session.update")
          ? h(
              "div",
              { class: "card-pick" },
              h("div", { class: "sb-opts", "data-pick": "model" }, MODELS.map((m) => h("button", { class: "sb-b", "aria-pressed": s.model === m ? "true" : "false", disabled: !!busy, onclick: () => void update({ model: m }) }, m))),
              h("div", { class: "sb-opts", "data-pick": "effort" }, EFFORTS.map(([k, l]) => h("button", { class: "sb-b", "aria-pressed": s.effort === k ? "true" : "false", disabled: !!busy, onclick: () => void update({ effort: k }) }, l))),
            )
          : null,
        h("button", { class: "card-act", "data-act": "names", onclick: () => openNames(app, el, callsign) }, "Имена"),
        // пункты места card.menu: закрепление (web-board)
        app
          .placed("card.menu")
          .filter((x) => x.show({ callsign }))
          .map((x) => h("button", { class: "card-act", "data-screen": x.screen, onclick: () => placedAct(app, x.screen, callsign) }, x.label)),
        remote ? h("a", { class: "card-act", href: remote, target: "_blank", rel: "noopener" }, "Открыть в claude.ai") : null,
        s && !stopped && can("session.stop") ? h("button", { class: "card-act", disabled: !!busy, onclick: () => act("session.stop") }, busy === "session.stop" ? "Останавливаю…" : "Остановить") : null,
        s && stopped && can("session.start") ? h("button", { class: "card-act", disabled: !!busy, onclick: () => act("session.start") }, busy === "session.start" ? "Поднимаю…" : "Поднять") : null,
        error ? h("div", { class: "sb-badc", role: "alert" }, h("b", null, "Не вышло"), h("code", null, error)) : null,
      );
    }

    /** вкладки: чат, вставки места card.tab, видные этой сессии, сведения */
    const tabList = (): Array<[string, string]> => [
      ["chat", "Чат"],
      ...app
        .placed("card.tab")
        .filter((t) => t.show({ callsign }))
        .map((t): [string, string] => [t.screen, t.label]),
      ["info", "Ещё"],
    ];

    function drawTabs() {
      const list = tabList();
      if (!list.some(([k]) => k === tab)) tab = "chat";
      tabs.textContent = "";
      for (const [k, label] of list) tabs.append(h("button", { role: "tab", "aria-selected": tab === k ? "true" : "false", "data-tab": k, onclick: () => select(k) }, label));
    }

    function draw() {
      drawTabs();
      if (tab === "info") {
        place.textContent = "";
        place.append(info());
      } else if (!inner) inner = app.open(tab, { callsign }, place);
    }

    function select(k: string) {
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
        const name = sessionName(app, callsign);
        const at = machineName(app, machineOf(callsign) ?? "").text;
        if (!s) return { title: name.text, mono: !name.human, sub: `${at} не на связи` };
        // лампа без слов: состояние понятно по индикатору
        return { title: name.text, mono: !name.human, sub: `${at} · ${projectOf(s.dir)}`, dot: s.state === "failed" ? "bad" : stateLabel(s.state).dot };
      },
      refresh: () => {
        if (tab === "info") draw();
        else drawTabs();
      },
      close: () => inner?.close?.(),
    };
  }

  return {
    screens: {
      card: { label: "Карточка", mount: mountCard },
      // группа «Шапка» в панели вида «Работы»: настройки шапки — у карточки
      "card.view": {
        label: "Шапка",
        path: "card-view",
        mount: (el) => {
          const units: Array<[keyof HeadView, string, string]> = [["haddr", "Адрес", "Адрес сессии"], ["howner", "Владелец", "Владелец в шапке"], ["hprof", "Профиль", "Профиль в шапке"], ["hmodel", "Модель", "Модель и усилие в шапке"]];
          const sync = () => units.forEach(([k], i) => row.children[i].setAttribute("aria-pressed", String(head[k])));
          const save = (next: HeadView) => {
            head = next;
            void app.store<HeadView>("card.head").set(head);
            sync();
            app.changed();
          };
          const row = h("div", { class: "vw-c" }, units.map(([k, label, full]) => h("button", { "data-v": k, "aria-label": full, onclick: () => save({ ...head, [k]: !head[k] }) }, label)));
          const box = h("div", { class: "vw-g" }, h("span", { class: "vw-t" }, "Шапка"), row);
          box.addEventListener("sb-reset", () => save({ ...HEAD0 }));
          el.append(box);
          sync();
        },
      },
    },
    css: CSS + WIDE_CSS,
    store: ["card.info", "card.head"],
    async start(a) {
      app = a;
      info = (await app.store<boolean>("card.info").get()) === true;
      head = { ...HEAD0, ...(await app.store<HeadView>("card.head").get()) };
    },
  };
}
