// Карточка сессии в широком виде (пульт), по прототипу «Пульт и телефон»: шапка — одна строка
// (лампа с подсказкой состояния, позывной, «модель · усилие ▾», «аккаунт · % ▾», вкладки, «Прервать»/«Запустить», «⋯»),
// плашка — только у не запустившейся, сведения сбоку — по желанию. Вкладки: «Разговор» · вкладки места card.tab
// · «Настройки» · «Журнал». Поле — у своего владельца: модель, усилие, быстрый режим, заголовок — session.update;
// слот — session.slot; профиль — session.profile; итог изменения — из следующего roster. Нет имени в contract — нет кнопки.
import { add, h, hhmm, type App, type ScreenHandle, type SessionRecord } from "@switchboard/web-core";
import { machineOf } from "@switchboard/protocol";

export const WIDE_CSS = `
.cw{flex:1;min-height:0;display:flex;flex-direction:column}
.cw-h{flex:none;display:flex;align-items:center;gap:10px;padding:0 10px 0 16px;min-height:48px;background:var(--surface);border-bottom:1px solid var(--line2);flex-wrap:nowrap}
.cw-lamp{flex:none;cursor:help;animation:none}
.cw-cs{font:600 16px var(--mono);white-space:nowrap}
.cw-hpw{position:relative;display:flex;gap:6px;flex:none}
.cw-hb{font:500 12.5px/1.3 var(--body);border:1px solid var(--line2);background:var(--surface2);color:var(--ink);border-radius:999px;padding:3px 10px;white-space:nowrap}
.cw-hb.lim{background:var(--wait-weak);color:var(--wait);border-color:transparent}
.cw-hb.you{background:var(--wait);color:var(--on-wait,#fff);border-color:transparent}
.cw-tabs{display:flex;gap:2px;margin-left:auto;align-self:stretch}
.cw-tabs button{font:500 13.5px var(--body);padding:0 11px;border:0;border-bottom:2px solid transparent;background:none;color:var(--muted);border-radius:0;white-space:nowrap}
.cw-tabs button[aria-selected="true"]{color:var(--ink);border-bottom-color:var(--ink);font-weight:600}
.cw-tabs button .n{font-size:11.5px;color:var(--muted);margin-left:3px}
.cw-b{font:600 12.5px/1.2 var(--body);border:1px solid var(--line);background:var(--surface);color:var(--ink);border-radius:8px;padding:6px 10px;white-space:nowrap;text-decoration:none;display:inline-flex;align-items:center;gap:4px}
.cw-b.pri{background:var(--accent);border-color:var(--accent);color:var(--on-accent)}
.cw-b.bad{color:var(--bad);border-color:var(--bad);background:transparent}
.cw-b.ghost{border-color:transparent;background:transparent}
.cw-b[aria-pressed="true"]{background:var(--accent);border-color:var(--accent);color:var(--on-accent)}
.cw-b[disabled]{opacity:.45;cursor:default}
.cw-why{font-size:12px;color:var(--bad);white-space:nowrap}
.cw-mw{position:relative;flex:none}
.cw-more{font-size:18px;line-height:1;padding:4px 10px}
.cw-pop{position:absolute;top:calc(100% + 6px);z-index:6;width:270px;background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:8px;display:flex;flex-direction:column;gap:2px;box-shadow:0 12px 36px rgba(0,0,0,.18)}
.cw-pop.l{left:0}.cw-pop.r{right:0}.cw-pop.w{width:340px}
.cw-pop hr{border:0;border-top:1px solid var(--line2);margin:4px 0;width:100%}
.cw-pop .lb{font-size:11.5px;color:var(--muted);padding:2px 8px}
.cw-mi{display:block;text-align:left;width:100%;border:0;background:transparent;border-radius:8px;padding:6px 8px;font:500 13px var(--body);color:var(--ink);text-decoration:none}
.cw-mi:hover{background:var(--accent-weak)}
.cw-kv{display:grid;grid-template-columns:auto minmax(0,1fr);gap:2px 10px;font-size:12.5px;padding:4px 8px 8px}
.cw-kv dt{color:var(--muted)}.cw-kv dd{margin:0;font-weight:600;overflow-wrap:anywhere}
.cw-opts{display:flex;flex-wrap:wrap;gap:4px;align-items:center;padding:2px 6px}
.cw-win{display:grid;grid-template-columns:96px minmax(0,1fr) 128px;gap:8px;align-items:center;font-size:12.5px;padding:2px 8px}
.cw-win .v{white-space:nowrap;color:var(--muted);font-size:11.5px}
.cw-meter{height:6px;border-radius:999px;background:var(--surface2);overflow:hidden;border:1px solid var(--line2)}
.cw-meter i{display:block;height:100%;background:var(--busy)}
.cw-meter.hot i{background:var(--wait)}.cw-meter.full i{background:var(--bad)}
.cw-pl{flex:none;display:flex;gap:10px;align-items:center;padding:9px 16px;border-bottom:1px solid var(--line2);background:var(--bad-weak)}
.cw-pl b{flex:1;font-size:13.5px;color:var(--bad)}
.cw-body{flex:1;min-height:0;display:grid;grid-template-columns:minmax(0,1fr)}
.cw-body.info{grid-template-columns:minmax(0,1fr) 262px}
.cw-place{min-height:0;min-width:0;display:flex;flex-direction:column}
.cw-info{border-left:1px solid var(--line2);background:var(--surface);padding:12px 14px;display:flex;flex-direction:column;gap:14px;font-size:13px;min-height:0;overflow-y:auto}
.cw-info h4{margin:0 0 5px;font:600 12px var(--body);color:var(--muted)}
.cw-info .cw-kv{padding:0}
.cw-sw{display:flex;align-items:center;gap:8px;padding:2px 0;font-size:13px}
.cw-sw span{flex:1}
.cw-set{flex:1;min-height:0;overflow-y:auto;padding:16px 18px;display:flex;flex-direction:column;gap:14px;max-width:680px}
.cw-fs{display:flex;flex-direction:column;gap:6px}
.cw-fs>.lb{font:600 12px var(--body);color:var(--muted)}
.cw-in{border:1px solid var(--line);border-radius:8px;padding:7px 10px;font:13.5px var(--body);color:var(--ink);background:var(--surface);min-width:0}
.cw-note{font-size:12.5px;color:var(--muted)}
.cw-note.ok{color:var(--ok)} .cw-note.bad{color:var(--bad)}
.cw-confirm{border:1px solid var(--bad);border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:8px;font-size:13px}
.cw-log{flex:1;min-height:0;overflow-y:auto;padding:12px 16px;display:flex;flex-direction:column;gap:6px}
.cw-lr{display:grid;grid-template-columns:70px 52px 110px minmax(0,1fr);gap:8px;font:12.5px/1.4 var(--mono);padding:4px 0;border-bottom:1px solid var(--line2)}
.cw-lr .k{font-weight:600}
.cw-lr .k.stop{color:var(--bad)} .cw-lr .k.refuse{color:var(--wait)} .cw-lr .k.note{color:var(--muted)}
.cw-lr .w{color:var(--muted)}
.cw-lr .x{overflow-wrap:anywhere}
`;

/** Подпись и лампа состояния (подсказка индикатора). */
const LABEL: Record<string, [string, string]> = {
  busy: ["работает", "busy"],
  waiting: ["ждёт вас", "wait"],
  failed: ["не запустилась", "bad"],
  idle: ["свободна", "idle"],
  starting: ["запускается", "busy"],
  stopping: ["останавливается", "stop"],
  stopped: ["остановлена", "stop"],
};
/** Модели, когда SDK машины не спросить (сессия не живая). */
const MODELS = ["opus", "sonnet", "haiku", "fable"];
const EFFORTS: Array<[string, string]> = [["low", "низкое"], ["medium", "среднее"], ["high", "высокое"], ["xhigh", "очень высокое"], ["max", "макс."]];
const effName = (e: unknown) => EFFORTS.find(([k]) => k === e)?.[1] ?? String(e ?? "");
const LIVE = new Set(["idle", "busy", "waiting"]);
/** Окна лимитов аккаунта → подпись. */
const WINDOWS: Record<string, string> = { five_hour: "5 часов", seven_day: "неделя", seven_day_opus: "неделя Opus" };
/** С этой доли окна 5 часов кнопка аккаунта жёлтая. */
const LIMIT_HINT = 0.7;

type Win = { utilization: number; resetsAt?: number };
type Acc = { email?: string; plan?: string; limits?: Record<string, Win> };
type SlotInfo = { account: string | null; order?: string[] };
type Mcp = { name: string; status?: string };
type Rec = { t: string; part?: string; who?: string; kind?: string; ev?: string; word?: string; why?: string; callsign?: string };
type Model = { value: string; displayName?: string };

const msg = (r: { ok: boolean; error?: string }) => (r.ok ? "" : String(r.error));
/** Время сброса: секунды или миллисекунды эпохи → ЧЧ:ММ. */
const at = (t: number) => hhmm(t < 1e12 ? t * 1000 : t);

/** Полночь сегодня по местному времени — since журнала машины. */
function midnight(daysBack = 0): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - daysBack);
  return d.toISOString();
}

/** Состояние карточки, общее для всех карточек модуля: сведения сбоку — выбор устройства. */
export type WideOpts = { info: () => boolean; setInfo: (v: boolean) => void };

/** Карточка сессии в широком виде. */
export function mountWide(app: App, el: HTMLElement, params: Record<string, string>, o: WideOpts): ScreenHandle {
  const callsign = params.callsign ?? "";
  const machine = machineOf(callsign) ?? "";
  let tab = params.tab ?? "chat";
  /** экран вкладки: чат и вкладки места card.tab — через ядро (их перерисовывает ядро), свои — здесь */
  let inner: ScreenHandle | undefined;
  let own: ScreenHandle | undefined;
  let headNote = "";
  /** открытое окно шапки: модель, аккаунт или меню ⋯ */
  let pop: "" | "model" | "acc" | "menu" = "";
  let accounts: Record<string, Acc> | null = null;
  let slots: Record<string, SlotInfo> | null = null;
  let models: Model[] | null = null;
  let mcp: Mcp[] | null = null;

  const session = (): SessionRecord | undefined => app.roster()?.sessions.find((s) => s.callsign === callsign);
  const can = (name: string) => app.provides(machine)?.[name] !== undefined;
  const live = () => LIVE.has(String(session()?.state));
  const slotOf = (s?: SessionRecord) => s?.slot as { name?: string; wait?: number | null } | null | undefined;
  const profileOf = (s?: SessionRecord) => (s?.profile as { id?: string } | null | undefined)?.id;

  const head = h("div", { class: "cw-h" });
  const plaque = h("div", { class: "cw-pl", role: "status", hidden: true });
  const place = h("div", { class: "cw-place" });
  const side = h("aside", { class: "cw-info", "aria-label": "Сведения" });
  const body = h("div", { class: "cw-body" }, place);
  el.append(h("div", { class: "cw" }, head, plaque, body));

  // окна шапки закрываются кликом мимо и Esc; клик внутри шапки помечает её слушатель — кнопка после перерисовки уже не в DOM
  const inHead = new WeakSet<Event>();
  head.addEventListener("click", (e) => inHead.add(e));
  const outside = (e: Event) => {
    if (pop && !inHead.has(e)) {
      pop = "";
      drawHead();
    }
  };
  const esc = (e: Event) => {
    if ((e as KeyboardEvent).key === "Escape" && pop) {
      pop = "";
      drawHead();
    }
  };
  document.addEventListener("click", outside);
  document.addEventListener("keydown", esc);

  // ───── запросы шапки ─────
  async function interrupt() {
    const r = await app.request("session.call", { callsign, method: "interrupt", args: [] });
    headNote = r.ok ? "" : `Прервать: ${msg(r)}`;
    drawHead();
  }

  async function start() {
    const r = await app.request("session.start", { callsign });
    if (!r.ok) app.toast(`${callsign}: «Запустить» — ${msg(r)}`);
  }

  async function update(body: Record<string, unknown>, what: string) {
    pop = "";
    drawHead();
    const r = await app.request("session.update", { callsign, ...body });
    if (!r.ok) app.toast(`${callsign}: ${what} — ${msg(r)}`);
  }

  /** аккаунты и слоты машины: подпись кнопки аккаунта и её окно */
  async function loadAccounts() {
    const jobs: Array<Promise<void>> = [];
    if (can("machine.accounts"))
      jobs.push(
        app.request<{ accounts: Record<string, Acc> }>("machine.accounts", { machine }).then((r) => {
          if (r.ok) accounts = r.result.accounts ?? {};
        }),
      );
    if (can("machine.slots"))
      jobs.push(
        app.request<{ slots: Record<string, SlotInfo> }>("machine.slots", { machine }).then((r) => {
          if (r.ok) slots = r.result.slots ?? {};
        }),
      );
    await Promise.all(jobs.map((j) => j.then(drawHead)));
  }

  async function loadModels() {
    if (models || !live() || !can("session.call")) return;
    const r = await app.request<Model[]>("session.call", { callsign, method: "supportedModels", args: [] });
    if (r.ok && Array.isArray(r.result)) models = r.result;
    drawHead();
  }

  function toggle(p: "model" | "acc" | "menu") {
    pop = pop === p ? "" : p;
    if (pop === "model") void loadModels();
    if (pop === "acc") void loadAccounts();
    drawHead();
  }

  // ───── шапка ─────
  function tip(s: SessionRecord): string {
    const [label] = LABEL[String(s.state)] ?? [String(s.state)];
    const why = s.failed ? Object.entries(s.failed as Record<string, string>).map(([k, v]) => `${k}: ${v}`).join("; ") : "";
    return s.state === "failed" && why ? `${label}: ${why}` : label;
  }

  function modelPop(s: SessionRecord): HTMLElement {
    const list: Model[] = models ?? MODELS.map((m) => ({ value: m }));
    return h(
      "div",
      { class: "cw-pop l", role: "dialog", "aria-label": "Модель и усилие" },
      h("span", { class: "lb" }, "Модель"),
      list.map((m) =>
        h("button", { class: "cw-mi", role: "menuitemradio", "aria-checked": m.value === s.model ? "true" : "false", "data-model": m.value, onclick: () => void update({ model: m.value }, "модель") }, `${m.value === s.model ? "✓ " : ""}${m.displayName ?? m.value}`),
      ),
      h("span", { class: "lb" }, "Усилие"),
      h(
        "div",
        { class: "cw-opts" },
        EFFORTS.map(([k, l]) => h("button", { class: "cw-b", "aria-pressed": s.effort === k ? "true" : "false", "data-effort": k, onclick: () => void update({ effort: k }, "усилие") }, l)),
      ),
    );
  }

  function accPop(s: SessionRecord): HTMLElement {
    const name = String(s.account ?? "");
    const a = accounts?.[name];
    const sl = slotOf(s);
    const queue = sl?.name ? (slots?.[sl.name]?.order ?? []) : [];
    return h(
      "div",
      { class: "cw-pop l w", role: "dialog", "aria-label": "Аккаунт и лимиты" },
      h(
        "dl",
        { class: "cw-kv" },
        h("dt", null, "аккаунт"),
        h("dd", null, [a?.email ?? name, a?.plan].filter(Boolean).join(" · ")),
        sl?.name ? [h("dt", null, "слот"), h("dd", null, `${sl.name} @${machine}`)] : null,
      ),
      Object.entries(a?.limits ?? {}).map(([k, w]) => {
        const p = Math.round(w.utilization * 100);
        return h(
          "div",
          { class: "cw-win", "data-win": k },
          h("span", null, WINDOWS[k] ?? k),
          h("div", { class: `cw-meter${p >= 95 ? " full" : p >= 70 ? " hot" : ""}` }, h("i", { style: `width:${Math.min(p, 100)}%` })),
          h("span", { class: "v" }, `${p} %${w.resetsAt ? " · до " + at(w.resetsAt) : ""}`),
        );
      }),
      queue.length ? h("div", { class: "cw-note", style: "padding:2px 8px" }, `очередь слота: ${queue.join(" → ")}`) : null,
      can("session.slot") ? h("div", { class: "cw-opts" }, h("button", { class: "cw-b", onclick: () => ((pop = ""), select("set")) }, "Сменить слот")) : null,
    );
  }

  function menuPop(s: SessionRecord): HTMLElement {
    const remote = (s.remote as { url?: string } | undefined)?.url;
    const inc = s.incident as { type?: string; key?: string } | null | undefined;
    return h(
      "div",
      { class: "cw-pop r", role: "menu", "aria-label": `Сессия ${callsign}` },
      h(
        "dl",
        { class: "cw-kv" },
        h("dt", null, "профиль"),
        h("dd", null, profileOf(s)?.split("/").at(-1) ?? "без профиля"),
        typeof s.dir === "string" ? [h("dt", null, "папка"), h("dd", null, s.dir)] : null,
        h("dt", null, "машина"),
        h("dd", null, `@${machine}`),
        inc?.type ? [h("dt", null, "инцидент"), h("dd", null, [inc.type, inc.key].filter(Boolean).join(" · "))] : null,
      ),
      h("hr"),
      h("button", { class: "cw-mi", role: "menuitemcheckbox", "aria-checked": o.info() ? "true" : "false", "data-act": "info", onclick: () => ((pop = ""), o.setInfo(!o.info()), drawBody(), drawHead()) }, `${o.info() ? "✓ " : ""}Сведения сбоку`),
      // пункты места card.menu: экраны других модулей («Новая задача рядом» — pult-open), открываются с позывным
      app
        .placed("card.menu")
        .filter((x) => x.show({ callsign }))
        .map((x) => h("button", { class: "cw-mi", role: "menuitem", "data-screen": x.screen, onclick: () => ((pop = ""), app.open(x.screen, { from: callsign })) }, x.label)),
      remote ? h("a", { class: "cw-mi", role: "menuitem", href: remote, target: "_blank", rel: "noopener" }, "Открыть в claude.ai ↗") : null,
    );
  }

  function drawHead() {
    const s = session();
    head.textContent = "";
    if (!s) {
      head.append(h("span", { class: "sb-dot stop cw-lamp", role: "img", title: "не на связи", "aria-label": "не на связи" }), h("b", { class: "cw-cs" }, callsign), h("span", { class: "cw-note" }, `${machine} не на связи`), tabsEl());
      return;
    }
    const [, dot] = LABEL[String(s.state)] ?? ["", ""];
    const t = tip(s);
    const sl = slotOf(s);
    const w5 = accounts?.[String(s.account ?? "")]?.limits?.five_hour;
    const accText = sl?.wait ? `ждёт сброса ${at(sl.wait)}` : w5 ? `${Math.round(w5.utilization * 100)} %` : "";
    const accCls = sl?.wait ? "you" : w5 && w5.utilization >= LIMIT_HINT ? "lim" : "";
    const stopped = s.state === "stopped" || s.state === "failed";
    add(
      head,
      h("span", { class: `sb-dot ${dot} cw-lamp`, tabindex: "0", role: "img", title: t, "aria-label": t, "data-tip": t }),
      h("b", { class: "cw-cs" }, callsign),
      h(
        "span",
        { class: "cw-hpw" },
        s.model || can("session.update")
          ? h("button", { class: "cw-hb", "data-pop": "model", "aria-expanded": pop === "model" ? "true" : "false", disabled: !can("session.update") }, `${[s.model, effName(s.effort)].filter(Boolean).join(" · ")} ▾`)
          : null,
        s.account ? h("button", { class: `cw-hb ${accCls}`, "data-pop": "acc", "aria-expanded": pop === "acc" ? "true" : "false" }, `${[s.account, accText].filter(Boolean).join(" · ")} ▾`) : null,
        pop === "model" ? modelPop(s) : pop === "acc" ? accPop(s) : null,
      ),
      tabsEl(),
      s.state === "busy" && can("session.call") ? h("button", { class: "cw-b bad", onclick: () => void interrupt() }, "■ Прервать") : null,
      stopped && can("session.start") ? h("button", { class: "cw-b pri", onclick: () => void start() }, "Запустить") : null,
      headNote ? h("span", { class: "cw-why" }, headNote) : null,
      h("span", { class: "cw-mw" }, h("button", { class: "cw-b ghost cw-more", "data-pop": "menu", "aria-haspopup": "menu", "aria-expanded": pop === "menu" ? "true" : "false", "aria-label": "Действия сессии" }, "⋯"), pop === "menu" ? menuPop(s) : null),
    );
    for (const b of head.querySelectorAll<HTMLButtonElement>("[data-pop]")) b.addEventListener("click", () => toggle(b.dataset.pop as "model" | "acc" | "menu"));
  }

  /** плашка — только у не запустившейся: причина и журнал */
  function drawPlaque() {
    const s = session();
    plaque.textContent = "";
    plaque.hidden = s?.state !== "failed";
    if (plaque.hidden) return;
    const why = s!.failed ? Object.entries(s!.failed as Record<string, string>).map(([k, v]) => `${k}: ${v}`).join("; ") : "";
    add(plaque, h("b", null, `Не запустилась${why ? ": " + why : ""}`), can("machine.journal") ? h("button", { class: "cw-b", onclick: () => select("log") }, "Почему") : null);
  }

  // ───── сведения сбоку ─────
  async function loadMcp() {
    if (mcp || !live() || !can("session.call")) return;
    const r = await app.request<Mcp[]>("session.call", { callsign, method: "mcpServerStatus", args: [] });
    if (r.ok && Array.isArray(r.result)) mcp = r.result;
    drawSide();
  }

  async function mcpToggle(m: Mcp) {
    const r = await app.request("session.call", { callsign, method: "toggleMcpServer", args: [m.name, m.status === "disabled"] });
    if (!r.ok) return app.toast(`toggleMcpServer: ${msg(r)}`);
    mcp = null;
    await loadMcp();
  }

  function drawSide() {
    const s = session();
    side.textContent = "";
    if (!s) return;
    const kids = (app.roster()?.sessions ?? []).filter((x) => x.parent === callsign).map((x) => x.callsign);
    const from = typeof s.from === "string" ? s.from : "";
    const remote = (s.remote as { url?: string } | undefined)?.url;
    add(
      side,
      h(
        "div",
        null,
        h("h4", null, "Сведения"),
        h(
          "dl",
          { class: "cw-kv" },
          from ? [h("dt", null, "задачу дал"), h("dd", null, from)] : null,
          typeof s.dir === "string" ? [h("dt", null, "папка"), h("dd", null, s.dir)] : null,
          h("dt", null, "профиль"),
          h("dd", null, profileOf(s)?.split("/").at(-1) ?? "без профиля"),
        ),
      ),
      typeof s.parent === "string" || kids.length
        ? h(
            "div",
            null,
            h("h4", null, "Дерево"),
            h(
              "dl",
              { class: "cw-kv" },
              typeof s.parent === "string" ? [h("dt", null, "открыла"), h("dd", null, s.parent)] : null,
              kids.length ? [h("dt", null, "ведёт"), h("dd", null, kids.map((k) => h("button", { class: "cw-b ghost", style: "padding:0 4px", onclick: () => app.open("card", { callsign: k }) }, k)))] : null,
            ),
          )
        : null,
      mcp?.length ? h("div", null, h("h4", null, "Серверы MCP"), mcp.map((m) => h("label", { class: "cw-sw" }, h("span", null, m.name), h("button", { class: "cw-b", "data-mcp": m.name, onclick: () => void mcpToggle(m) }, m.status === "disabled" ? "вкл" : "выкл")))) : null,
      remote ? h("a", { class: "cw-mi", style: "padding:0", href: remote, target: "_blank", rel: "noopener" }, "Открыть в claude.ai ↗") : null,
    );
  }

  function drawBody() {
    const on = o.info();
    body.classList.toggle("info", on);
    if (on && !side.isConnected) {
      body.append(side);
      void loadMcp();
    }
    if (!on) side.remove();
    if (on) drawSide();
  }

  // ───── вкладки ─────
  /** вставки места card.tab, видные этой сессии */
  const placed = () => app.placed("card.tab").filter((t) => t.show({ callsign }));

  function tabList(): Array<[string, string]> {
    const out: Array<[string, string]> = [["chat", "Разговор"]];
    for (const t of placed()) out.push([t.screen, t.label]);
    out.push(["set", "Настройки"]);
    if (can("machine.journal")) out.push(["log", "Журнал"]);
    return out;
  }

  function tabsEl(): HTMLElement {
    return h(
      "div",
      { class: "cw-tabs", role: "tablist" },
      tabList().map(([k, label]) => h("button", { role: "tab", "aria-selected": tab === k ? "true" : "false", "data-tab": k, onclick: () => select(k) }, label)),
    );
  }

  function select(k: string) {
    if (k === tab) return;
    tab = k;
    openTab();
  }

  function openTab() {
    inner?.close?.();
    inner = own = undefined;
    place.textContent = "";
    if (tab === "chat") inner = app.open("chat", { callsign }, place);
    else if (placed().some((t) => t.screen === tab)) inner = app.open(tab, { callsign }, place);
    else if (tab === "log" && can("machine.journal")) own = mountLog();
    else {
      tab = "set";
      own = mountSet();
    }
    drawHead();
  }

  // ───── настройки ─────
  function mountSet(): ScreenHandle {
    const box = h("div", { class: "cw-set" });
    place.append(box);
    const notes: Record<string, { text: string; tone: string }> = {};
    let profiles: string[] | null = null;
    let title: string | null = null;
    let titleEdit: string | undefined;
    let removing = false;

    const note = (k: string, text: string, tone = "") => {
      notes[k] = { text, tone };
      draw();
    };
    const noteEl = (k: string) => (notes[k]?.text ? h("div", { class: `cw-note ${notes[k].tone}`, role: "status" }, notes[k].text) : null);

    async function load() {
      const jobs: Array<Promise<void>> = [];
      if (can("session.spec"))
        jobs.push(
          app.request<{ title?: string | null }>("session.spec", { callsign }).then((r) => {
            if (r.ok) title = r.result.title ?? "";
          }),
        );
      if (can("machine.profiles"))
        jobs.push(
          app.request<{ profiles: Record<string, unknown> }>("machine.profiles", { machine }).then((r) => {
            if (r.ok) profiles = Object.keys(r.result.profiles ?? {});
          }),
        );
      if (!slots && can("machine.slots"))
        jobs.push(
          app.request<{ slots: Record<string, SlotInfo> }>("machine.slots", { machine }).then((r) => {
            if (r.ok) slots = r.result.slots ?? {};
          }),
        );
      await Promise.all(jobs.map((j) => j.then(draw)));
    }

    async function move(name: "session.slot" | "session.profile", value: string | null) {
      const key = name === "session.slot" ? "slot" : "profile";
      note(key, "…");
      const r = await app.request<{ restart?: boolean }>(name, { callsign, [key]: value });
      if (!r.ok) return note(key, `Не вышло: ${msg(r)}`, "bad");
      note(key, r.result?.restart ? "после хода" : "", "ok");
    }

    async function setTitle() {
      if (titleEdit === undefined || titleEdit === (title ?? "")) return;
      const r = await app.request("session.update", { callsign, title: titleEdit });
      if (!r.ok) return note("title", `Не вышло: ${msg(r)}`, "bad");
      title = titleEdit;
      titleEdit = undefined;
      note("title", "");
    }

    async function act(name: "session.stop" | "session.start" | "session.remove") {
      note("ctl", "…");
      const r = await app.request(name, { callsign });
      if (!r.ok) return note("ctl", `${name}: ${msg(r)}`, "bad");
      if (name === "session.remove") return app.back();
      note("ctl", "");
    }

    function draw() {
      const s = session();
      const keep = document.activeElement instanceof HTMLInputElement && box.contains(document.activeElement);
      box.textContent = "";
      const profNow = profileOf(s) ?? "";
      const slotNow = slotOf(s)?.name ?? "";
      const fast = !!(s?.fast as boolean | undefined);
      const t = h("input", { class: "cw-in", "data-f": "title", placeholder: "Заголовок в claude.ai", value: titleEdit ?? title ?? "" }) as HTMLInputElement;
      t.addEventListener("input", () => (titleEdit = t.value));
      t.addEventListener("change", () => void setTitle());
      const stopped = s?.state === "stopped" || s?.state === "failed";
      add(
        box,
        can("session.profile")
          ? h(
              "div",
              { class: "cw-fs", "data-sec": "profile" },
              h("span", { class: "lb" }, "Профиль"),
              h(
                "div",
                { class: "cw-opts", style: "padding:0" },
                [...(profiles ?? (profNow ? [profNow] : [])), ""].map((p) =>
                  h("button", { class: "cw-b", "aria-pressed": profNow === p ? "true" : "false", "data-profile": p, onclick: () => (p === profNow ? null : void move("session.profile", p || null)) }, p ? p.split("/").at(-1) : "без профиля"),
                ),
              ),
              noteEl("profile"),
            )
          : null,
        can("session.update")
          ? h(
              "label",
              { class: "cw-sw", "data-sec": "fast" },
              h("button", { class: "cw-b", role: "switch", "aria-checked": fast ? "true" : "false", "aria-pressed": fast ? "true" : "false", onclick: () => void update({ fast: !fast }, "быстрый режим") }, fast ? "вкл" : "выкл"),
              h("span", null, "Быстрый режим"),
            )
          : null,
        can("session.update") ? h("div", { class: "cw-fs", "data-sec": "title" }, h("span", { class: "lb" }, "Заголовок"), t, noteEl("title")) : null,
        can("session.slot")
          ? h(
              "div",
              { class: "cw-fs", "data-sec": "slot" },
              h("span", { class: "lb" }, "Слот"),
              h(
                "div",
                { class: "cw-opts", style: "padding:0" },
                [...Object.keys(slots ?? (slotNow ? { [slotNow]: 1 } : {})), ""].map((v) =>
                  h("button", { class: "cw-b", "aria-pressed": slotNow === v ? "true" : "false", "data-slot": v, onclick: () => (v === slotNow ? null : void move("session.slot", v || null)) }, v || "без слота"),
                ),
              ),
              noteEl("slot"),
            )
          : null,
        h(
          "div",
          { class: "cw-fs", "data-sec": "ctl" },
          h("span", { class: "lb" }, "Сессия"),
          h(
            "div",
            { class: "cw-opts", style: "padding:0" },
            s && live() && can("session.stop") ? h("button", { class: "cw-b", onclick: () => void act("session.stop") }, "Остановить") : null,
            s && stopped && can("session.start") ? h("button", { class: "cw-b pri", onclick: () => void act("session.start") }, "Запустить") : null,
            s && can("session.remove") && !removing ? h("button", { class: "cw-b bad", onclick: () => ((removing = true), draw()) }, "Убрать…") : null,
          ),
          removing
            ? h(
                "div",
                { class: "cw-confirm" },
                h("span", null, `${callsign} остановится и уйдёт из списка. Точки в R2 останутся.`),
                h("div", { class: "cw-opts", style: "padding:0" }, h("button", { class: "cw-b bad", onclick: () => void act("session.remove") }, "Убрать"), h("button", { class: "cw-b", onclick: () => ((removing = false), draw()) }, "Отмена")),
              )
            : null,
          noteEl("ctl"),
        ),
      );
      if (keep) box.querySelector<HTMLInputElement>('[data-f="title"]')?.focus();
    }

    void load();
    draw();
    return { refresh: draw };
  }

  // ───── журнал машины ─────
  function mountLog(): ScreenHandle {
    const box = h("div", { class: "cw-log" });
    place.append(box);
    let kind = "";
    let days = 0;
    let recs: Rec[] = [];
    let more = false;
    let err = "";
    let loading = false;

    async function load(since: string, append: boolean) {
      loading = true;
      draw();
      const r = await app.request<{ records: Rec[]; more: boolean }>("machine.journal", { machine, session: callsign, since, limit: 50, ...(kind ? { kind: [kind] } : {}) });
      loading = false;
      if (r.ok) {
        recs = append ? [...recs, ...r.result.records] : r.result.records;
        more = !!r.result.more;
        err = "";
      } else err = msg(r);
      draw();
    }
    const reload = () => void load(midnight(days), false);

    function draw() {
      box.textContent = "";
      box.append(
        h(
          "div",
          { class: "cw-opts", style: "padding:0" },
          ["", "stop", "refuse", "note"].map((k) => h("button", { class: "cw-b", "aria-pressed": kind === k ? "true" : "false", onclick: () => ((kind = k), reload()) }, k || "все")),
          h("span", { class: "cw-note" }, `${machine} · ${days ? `с ${days} дн. назад` : "сегодня"}`),
        ),
      );
      if (err) box.append(h("div", { class: "cw-note bad", role: "alert" }, `machine.journal: ${err}`));
      for (const x of recs) {
        const d = new Date(x.t);
        box.append(
          h(
            "div",
            { class: "cw-lr" },
            h("span", null, Number.isNaN(d.getTime()) ? x.t : `${hhmm(d)}:${String(d.getSeconds()).padStart(2, "0")}`),
            h("span", { class: `k ${x.kind ?? ""}` }, x.kind ?? ""),
            h("span", { class: "w" }, [x.part, x.who].filter(Boolean).join(" · ")),
            h("span", { class: "x" }, [x.ev, x.word, x.why].filter(Boolean).join(" · ")),
          ),
        );
      }
      if (!recs.length && !loading && !err) box.append(h("div", { class: "cw-note" }, "Записей нет."));
      if (more) box.append(h("button", { class: "cw-b", onclick: () => void load(recs.at(-1)!.t, true) }, "дальше →"));
      box.append(h("button", { class: "cw-b", onclick: () => ((days += 1), reload()) }, "Раньше"));
    }
    reload();
    return {};
  }

  openTab();
  drawPlaque();
  drawBody();
  void loadAccounts();
  return {
    head: () => {
      const s = session();
      if (!s) return { title: callsign, mono: true, sub: `${machine} не на связи` };
      const [label, dot] = LABEL[String(s.state)] ?? [String(s.state), ""];
      return { title: callsign, mono: true, sub: [s.model, effName(s.effort)].filter(Boolean).join(" · "), pill: { text: label, tone: dot === "idle" ? "ok" : dot === "stop" ? "" : (dot as "busy" | "wait" | "bad") } };
    },
    refresh: () => {
      drawHead();
      drawPlaque();
      if (o.info()) drawSide();
      own?.refresh?.();
    },
    close: () => {
      document.removeEventListener("click", outside);
      document.removeEventListener("keydown", esc);
      inner?.close?.();
    },
  };
}
