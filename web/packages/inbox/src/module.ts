// web-inbox — «Вам»: что ждёт вас. Карточки — из roster и меток других модулей; очереди и хранилища нет.
// Своя память — только то, что видно по смене roster при открытом приложении: «готово» (busy → idle) и ушедшие машины.
import { h, hhmm, type App, type AppModule, type Roster, type ScreenHandle, type SessionRecord } from "@switchboard/web-core";
import { machineOf } from "@switchboard/protocol";

const CSS = `
.ib{flex:1;min-height:0;overflow-y:auto;padding:8px 10px 16px;display:flex;flex-direction:column;gap:8px}
.sb-app.wide .ib{max-width:560px}
.ib-gh{font:600 12px var(--body);color:var(--muted);padding:8px 2px 0}
.ib-it{background:var(--surface);border:1px solid var(--line2);border-radius:12px;padding:11px 12px;display:flex;flex-direction:column;gap:8px}
.ib-it.you{border-color:var(--wait);box-shadow:inset 3px 0 0 var(--wait)}
.ib-it.bad{box-shadow:inset 3px 0 0 var(--bad)}
.ib-it.done{box-shadow:inset 3px 0 0 var(--ok)}
.ib-ih{display:flex;gap:8px;align-items:center;min-width:0}
.ib-ih .sb-dot{width:9px;height:9px;flex:none;animation:none}
.ib-cs{border:0;background:none;padding:0;font:600 13px var(--mono);color:var(--ink);text-decoration:underline;text-underline-offset:3px;text-decoration-color:var(--line);white-space:nowrap;flex:none}
.ib-lb{font-size:11.5px;color:var(--muted);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ib-tx{font-size:13.5px;overflow-wrap:anywhere}
.ib-acts{display:flex;gap:6px;flex-wrap:wrap}
.ib-acts button{font:600 13px var(--body);border:1px solid var(--line);background:var(--surface);color:var(--ink);border-radius:8px;padding:6px 11px}
.ib-acts button.pri{background:var(--accent);border-color:var(--accent);color:var(--on-accent)}
.ib-acts button.ghost{border-color:transparent;background:transparent}
.ib-q:empty{display:none}
.ib-empty{text-align:center;color:var(--muted);padding:36px 12px;display:flex;flex-direction:column;gap:6px}
.ib-empty b{color:var(--ink);font-weight:600}
`;

type Kind = "q" | "msg" | "fail" | "wait" | "away" | "fire" | "done";
type Item = { k: Kind; g: 0 | 1 | 2; s?: SessionRecord; m?: string; at?: number; list?: SessionRecord[]; n?: number };
const GROUPS = ["Ждут ответа", "Сломалось или ждёт", "Готово"];

/** Новый модуль со своей памятью (в выпуске — один; в тестах — на каждый прогон). */
export function createInbox(): AppModule {
  let app: App;
  let last: Roster | null = null;
  /** закончили ход, пока их не смотрели: позывной */
  const done = new Set<string>();
  /** машины, пропавшие из roster при открытом приложении: машина → когда и её сессии */
  const gone = new Map<string, { at: number; list: SessionRecord[] }>();
  /** «прочитано» на карточке «готово» — до следующего хода */
  const seen = new Set<string>();
  /** мои сессии по прошлому roster: сессий ушедшей машины в roster уже нет, «моё» о них — отсюда */
  let wasMine = new Set<string>();

  const viewing = (callsign: string) => {
    const c = app.current();
    return !!c && c.params.callsign === callsign && c.screen !== "inbox";
  };
  const mine = (callsign: string) => !!app.mark("mine", callsign);

  function onRoster(r: Roster) {
    const before = new Map((last?.sessions ?? []).map((s) => [s.callsign, s.state]));
    for (const s of r.sessions) {
      const was = before.get(s.callsign);
      if (s.state === "busy" || s.state === "starting" || s.state === "waiting") {
        done.delete(s.callsign);
        seen.delete(s.callsign);
      } else if ((was === "busy" || was === "starting") && s.state === "idle" && !viewing(s.callsign)) done.add(s.callsign);
    }
    const now = new Set(r.machines.map((m) => m.machine));
    for (const m of now) gone.delete(m);
    for (const m of last?.machines ?? []) {
      if (!now.has(m.machine)) gone.set(m.machine, { at: Date.now(), list: last!.sessions.filter((s) => machineOf(s.callsign) === m.machine && wasMine.has(s.callsign)) });
    }
    wasMine = new Set(r.sessions.filter((s) => mine(s.callsign)).map((s) => s.callsign));
    last = r;
  }

  /** Карточки сейчас: из roster, меток и того, что видно по смене roster. */
  function items(): Item[] {
    const out: Item[] = [];
    const r = app?.roster();
    if (!r) return out;
    for (const s of r.sessions) {
      if (app.mark("asked", s.callsign)) out.push({ k: "q", g: 0, s });
      else if (app.mark("unread", s.callsign)) out.push({ k: "msg", g: 0, s });
      if (!mine(s.callsign)) continue;
      if (s.state === "failed") out.push({ k: "fail", g: 1, s });
      const wait = (s.slot as { wait?: number | null } | null | undefined)?.wait;
      if (typeof wait === "number" && wait > 0) out.push({ k: "wait", g: 1, s, at: wait * 1000 });
      // открыли карточку сессии — «готово» прочитано
      if (viewing(s.callsign)) done.delete(s.callsign);
      if (s.state === "idle" && done.has(s.callsign) && !seen.has(s.callsign)) out.push({ k: "done", g: 2, s });
    }
    for (const [m, x] of gone) {
      if (x.list.length) out.push({ k: "away", g: 1, m, at: x.at, list: x.list });
    }
    // ушли раньше, чем открыто приложение, — знает модуль точек (только пульт)
    const fire = app.mark("fire");
    if (typeof fire === "number" && fire > gone.size) out.push({ k: "fire", g: 1, n: fire - gone.size });
    return out;
  }

  /** Заголовок карточки: лампа, позывной (открыть) и что случилось. */
  function head(s: SessionRecord, dot: string, label: string): HTMLElement {
    const project = app.mark("project", s.callsign) as string | null | undefined;
    return h(
      "div",
      { class: "ib-ih" },
      h("span", { class: `sb-dot ${dot}` }),
      h("button", { class: "ib-cs", onclick: () => app.open("card", { callsign: s.callsign }) }, s.callsign),
      h("span", { class: "ib-lb" }, [label, project].filter(Boolean).join(" · ")),
    );
  }

  /** экраны ask в карточках вопросов: закрываются при перерисовке «Вам» */
  const asks: Array<{ close?(): void }> = [];

  function card(it: Item): HTMLElement {
    const s = it.s;
    const open = () => app.open("card", { callsign: s!.callsign });
    switch (it.k) {
      case "q": {
        // вопрос — экраном web-ask в карточке: варианты, свой ответ; первый ответ с любого устройства убирает карточку
        const box = h("div", { class: "ib-q" });
        const el = h("div", { class: "ib-it you", "data-kind": "q", "data-callsign": s!.callsign }, head(s!, "wait", "спрашивает"), box);
        const hd = app.open("ask", { callsign: s!.callsign }, box);
        if (hd) asks.push(hd);
        return el;
      }
      case "msg": {
        const u = app.mark("unread", s!.callsign) as { count: number; text: string };
        return h("div", { class: "ib-it you", "data-kind": "msg", "data-callsign": s!.callsign }, head(s!, "wait", "пишет вам"), h("div", { class: "ib-tx" }, u.text), h("div", { class: "ib-acts" }, h("button", { class: "pri", onclick: open }, "Открыть")));
      }
      case "fail": {
        const why = s!.failed ? Object.values(s!.failed as Record<string, string>).join("; ") : "";
        return h(
          "div",
          { class: "ib-it bad", "data-kind": "fail", "data-callsign": s!.callsign },
          head(s!, "bad", "не запустилась"),
          why ? h("div", { class: "ib-tx" }, why) : null,
          h(
            "div",
            { class: "ib-acts" },
            h(
              "button",
              {
                class: "pri",
                onclick: async () => {
                  const r = await app.request("session.start", { callsign: s!.callsign });
                  if (!r.ok) app.toast(`${s!.callsign} не запустилась: ${r.error}`);
                },
              },
              "Запустить снова",
            ),
            h("button", { onclick: open }, "Почему"),
          ),
        );
      }
      case "wait": {
        const slot = (s!.slot as { name?: string }).name ?? "";
        return h(
          "div",
          { class: "ib-it bad", "data-kind": "wait", "data-callsign": s!.callsign },
          head(s!, "idle", "ждёт сброса лимита"),
          h("div", { class: "ib-tx" }, `Аккаунты слота ${slot} у порога — продолжит после ${hhmm(it.at!)}`),
          h("div", { class: "ib-acts" }, h("button", { onclick: open }, "Открыть")),
        );
      }
      case "away":
        return h(
          "div",
          { class: "ib-it bad", "data-kind": "away", "data-machine": it.m },
          h("div", { class: "ib-ih" }, h("span", { class: "sb-dot gone" }), h("b", { class: "ib-cs", style: "text-decoration:none" }, `@${it.m}`), h("span", { class: "ib-lb" }, `не на связи с ${hhmm(it.at!)}`)),
          h("div", { class: "ib-tx" }, it.list!.map((x) => x.callsign).join(", ")),
          app.mark("fire") !== undefined ? h("div", { class: "ib-acts" }, h("button", { class: "pri", onclick: () => app.open("points", {}) }, "Поднять из точки")) : null,
        );
      case "fire":
        return h(
          "div",
          { class: "ib-it bad", "data-kind": "fire" },
          h("div", { class: "ib-ih" }, h("span", { class: "sb-dot gone" }), h("span", { class: "ib-lb" }, `машин не на связи: ${it.n}`)),
          h("div", { class: "ib-acts" }, h("button", { class: "pri", onclick: () => app.open("points", {}) }, "Поднять из точки")),
        );
      default:
        return h(
          "div",
          { class: "ib-it done", "data-kind": "done", "data-callsign": s!.callsign },
          head(s!, "idle", "готово"),
          h("div", { class: "ib-acts" }, h("button", { onclick: open }, "Открыть"), h("button", { class: "ghost", onclick: () => (seen.add(s!.callsign), app.changed()) }, "Прочитано")),
        );
    }
  }

  function mountInbox(el: HTMLElement): ScreenHandle {
    const body = h("div", { class: "ib" });
    el.append(body);
    /** вопрос в карточке держит свой экран: карточку не пересоздаём, пока вопрос тот же */
    let shown: string | null = null;
    let drawing = false;
    function draw() {
      // экран ask в карточке при монтировании зовёт changed — перерисовка изнутри своей отрисовки не нужна
      if (drawing) return;
      const list = items();
      const sig = list.map((x) => `${x.k}:${x.s?.callsign ?? x.m ?? x.n}`).join("|");
      // карточки вопросов рисуют свои экраны ask — перерисовка только при смене состава
      if (sig === shown) return;
      shown = sig;
      drawing = true;
      for (const a of asks.splice(0)) a.close?.();
      body.textContent = "";
      if (!list.length) {
        body.append(h("div", { class: "ib-empty" }, h("b", null, "Всё разобрано")));
        drawing = false;
        return;
      }
      for (const g of [0, 1, 2] as const) {
        const xs = list.filter((x) => x.g === g);
        if (!xs.length) continue;
        body.append(h("div", { class: "ib-gh" }, `${GROUPS[g]} · ${xs.length}`), ...xs.map(card));
      }
      drawing = false;
    }
    draw();
    return { head: () => ({ title: "Вам" }), refresh: draw, close: () => asks.splice(0).forEach((a) => a.close?.()) };
  }

  return {
    on: { roster: onRoster },
    screens: { inbox: { nav: "Вам", mark: "you", label: "Вам", path: "inbox", mount: mountInbox } },
    marks: { you: () => items().length },
    css: CSS,
    start(a) {
      app = a;
    },
  };
}
