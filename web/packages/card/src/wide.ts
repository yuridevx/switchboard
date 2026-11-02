// Карточка сессии в широком виде (пульт): шапка из roster, плашка состояния, вкладки
// «Чат» · вкладки места card.tab (например «Точки») · «Настройки» · «Журнал машины».
// Каждое поле настроек — у своего владельца: модель, усилие, быстрый режим, стиль, заголовок — session.update;
// слот — session.slot; профиль — session.profile; папка и заголовок — session.spec; сведения — session.call.
// Итог изменения пульт берёт из следующего roster, а не из формы. Нет имени в contract машины — нет кнопки.
import { add, h, hhmm, stateLabel, type App, type ScreenHandle, type SessionRecord } from "@switchboard/web-core";
import { machineOf } from "@switchboard/protocol";

export const WIDE_CSS = `
.cw{flex:1;min-height:0;display:flex;flex-direction:column}
.cw-h{flex:none;display:flex;align-items:flex-start;gap:10px;padding:12px 16px 9px;background:var(--surface);border-bottom:1px solid var(--line2)}
.cw-ht{flex:1;min-width:0}
.cw-ht>b{font:600 16px var(--mono);margin-right:8px}
.cw-meta{display:flex;flex-wrap:wrap;gap:5px;margin-top:6px}
.cw-chip{font:500 11.5px/1.3 var(--mono);background:var(--surface2);border:1px solid var(--line2);border-radius:999px;padding:2px 8px;white-space:nowrap;color:var(--muted)}
.cw-chip.warn{color:var(--wait);border-color:var(--wait)}
.cw-acts{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end}
.cw-b{font:600 12.5px/1.2 var(--body);border:1px solid var(--line);background:var(--surface);color:var(--ink);border-radius:8px;padding:6px 10px;white-space:nowrap;text-decoration:none;display:inline-flex;align-items:center;gap:4px}
.cw-b.pri{background:var(--accent);border-color:var(--accent);color:var(--on-accent)}
.cw-b.bad{color:var(--bad);border-color:var(--bad);background:transparent}
.cw-b[aria-pressed="true"]{background:var(--accent-weak);border-color:var(--accent);color:var(--accent)}
.cw-b[disabled]{opacity:.45;cursor:default}
.cw-why{font-size:12px;color:var(--muted);max-width:30ch}
.cw-pl{flex:none;display:flex;gap:10px;align-items:center;padding:9px 16px;border-bottom:1px solid var(--line2)}
.cw-pl>div{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px;font-size:13px}
.cw-pl b{font-size:13.5px}
.cw-pl.bad{background:var(--bad-weak)} .cw-pl.bad b{color:var(--bad)}
.cw-pl.wait{background:var(--wait-weak)} .cw-pl.wait b{color:var(--wait)}
.cw-pl.stop{background:var(--surface2)}
.cw-tabs{flex:none;display:flex;gap:2px;padding:0 12px;background:var(--surface);border-bottom:1px solid var(--line2)}
.cw-tabs button{font:600 13px var(--body);padding:8px 10px;border:0;border-bottom:2px solid transparent;background:none;color:var(--muted);border-radius:0}
.cw-tabs button[aria-selected="true"]{color:var(--accent);border-bottom-color:var(--accent)}
.cw-place{flex:1;min-height:0;display:flex;flex-direction:column}
.cw-set{flex:1;min-height:0;overflow-y:auto;padding:14px 16px;display:flex;flex-direction:column;gap:12px}
.cw-sec{background:var(--surface);border:1px solid var(--line2);border-radius:12px;padding:12px 14px;display:flex;flex-direction:column;gap:8px}
.cw-h4{margin:0;font:600 10.5px var(--mono);letter-spacing:.1em;text-transform:uppercase;color:var(--muted)}
.cw-row{display:grid;grid-template-columns:96px minmax(0,1fr);gap:10px;align-items:center;font-size:13.5px}
.cw-row>span:first-child{color:var(--muted)}
.cw-opts{display:flex;flex-wrap:wrap;gap:4px;align-items:center}
.cw-in{border:1px solid var(--line);border-radius:8px;padding:6px 9px;font:13.5px var(--body);color:var(--ink);background:var(--bg);min-width:0}
.cw-mono{font-family:var(--mono);font-size:12.5px}
.cw-note{font-size:12.5px;color:var(--muted)}
.cw-note.ok{color:var(--ok)} .cw-note.bad{color:var(--bad)}
.cw-log{flex:1;min-height:0;overflow-y:auto;padding:12px 16px;display:flex;flex-direction:column;gap:6px}
.cw-lr{display:grid;grid-template-columns:70px 52px 110px minmax(0,1fr);gap:8px;font:12.5px/1.4 var(--mono);padding:4px 0;border-bottom:1px solid var(--line2)}
.cw-lr .k{font-weight:600}
.cw-lr .k.stop{color:var(--bad)} .cw-lr .k.refuse{color:var(--wait)} .cw-lr .k.note{color:var(--muted)}
.cw-lr .w{color:var(--muted)}
.cw-lr .x{overflow-wrap:anywhere}
`;

/** Подпись состояния в шапке широкого вида. */
const LABEL: Record<string, [string, string]> = {
  busy: ["отвечает", "busy"],
  waiting: ["ждёт ответа", "wait"],
  failed: ["не поднялась", "bad"],
  idle: ["свободна", "ok"],
  starting: ["запускается", "busy"],
  stopping: ["останавливается", ""],
  stopped: ["остановлена", ""],
};
const MODELS = ["opus", "sonnet", "haiku", "fable"];
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const LIVE = new Set(["idle", "busy", "waiting"]);
/** Окна лимитов аккаунта → подпись. */
const WINDOWS: Record<string, string> = { five_hour: "5 ч", seven_day: "неделя", seven_day_opus: "неделя opus" };
/** Порог подсказки лимита в шапке. */
const LIMIT_HINT = 0.7;

type Spec = { dir?: string; model?: string | null; effort?: string | null; title?: string | null };
type Mcp = { name: string; status?: string };
type Rec = { t: string; part?: string; who?: string; kind?: string; ev?: string; word?: string; why?: string; callsign?: string };

const msg = (r: { ok: boolean; error?: string }) => (r.ok ? "" : String(r.error));

/** Полночь сегодня по местному времени — since журнала машины. */
function midnight(daysBack = 0): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - daysBack);
  return d.toISOString();
}

/** Карточка сессии в широком виде. */
export function mountWide(app: App, el: HTMLElement, params: Record<string, string>): ScreenHandle {
  const callsign = params.callsign ?? "";
  const machine = machineOf(callsign) ?? "";
  let tab = params.tab ?? "chat";
  /** экран вкладки: чат и вкладки места card.tab — через ядро (их перерисовывает ядро), свои — здесь */
  let inner: ScreenHandle | undefined;
  let own: ScreenHandle | undefined;
  let limit = "";
  let headNote = "";
  let forget = false;

  const session = (): SessionRecord | undefined => app.roster()?.sessions.find((s) => s.callsign === callsign);
  const can = (name: string) => app.provides(machine)?.[name] !== undefined;
  const live = () => LIVE.has(String(session()?.state));

  const head = h("div", { class: "cw-h" });
  const plaque = h("div", { class: "cw-pl", role: "status" });
  const tabs = h("div", { class: "cw-tabs", role: "tablist" });
  const place = h("div", { class: "cw-place" });
  el.append(h("div", { class: "cw" }, head, plaque, tabs, place));

  // ───── шапка и плашка ─────
  async function interrupt() {
    const r = await app.request("session.call", { callsign, method: "interrupt", args: [] });
    headNote = r.ok ? "" : `Прервать: ${msg(r)}`;
    drawHead();
  }

  async function start() {
    const r = await app.request("session.start", { callsign });
    if (!r.ok) app.toast(`${callsign}: «Поднять» — ${msg(r)}`);
  }

  function drawHead() {
    const s = session();
    head.textContent = "";
    if (!s) {
      head.append(h("div", { class: "cw-ht" }, h("b", null, callsign), h("span", { class: "sb-pill" }, "не на связи"), h("div", { class: "cw-meta" }, h("span", { class: "cw-chip" }, `${machine} не в roster`))));
      return;
    }
    const [label, tone] = LABEL[String(s.state)] ?? [String(s.state), ""];
    const slot = (s.slot as { name?: string } | null | undefined)?.name;
    const profile = (s.profile as { id?: string } | null | undefined)?.id;
    const remote = s.remote as { url?: string; error?: string } | undefined;
    head.append(
      h(
        "div",
        { class: "cw-ht" },
        h("b", null, callsign),
        h("span", { class: `sb-pill ${tone}` }, label),
        h(
          "div",
          { class: "cw-meta" },
          h("span", { class: "cw-chip" }, machine),
          slot ? h("span", { class: "cw-chip" }, [slot, s.account].filter(Boolean).join(" · ")) : s.account ? h("span", { class: "cw-chip" }, String(s.account)) : null,
          s.model ? h("span", { class: "cw-chip" }, [s.model, s.effort].filter(Boolean).join(" · ")) : null,
          profile ? h("span", { class: "cw-chip" }, profile.split("/").at(-1)!) : null,
          limit ? h("span", { class: "cw-chip warn" }, limit) : null,
        ),
      ),
      h(
        "div",
        { class: "cw-acts" },
        remote?.url ? h("a", { class: "cw-b", href: remote.url, target: "_blank", rel: "noopener" }, "В claude.ai ↗") : remote?.error ? h("span", { class: "cw-why", title: "Remote Control" }, `claude.ai: ${remote.error}`) : null,
        s.state === "busy" && can("session.call") ? h("button", { class: "cw-b bad", onclick: () => void interrupt() }, "■ Прервать") : null,
        headNote ? h("span", { class: "cw-why" }, headNote) : null,
      ),
    );
  }

  function drawPlaque() {
    const s = session();
    plaque.textContent = "";
    plaque.className = "cw-pl";
    plaque.hidden = true;
    if (!s) return;
    const remote = (s.remote as { url?: string } | undefined)?.url;
    if (s.state === "failed") {
      const why = s.failed ? Object.entries(s.failed as Record<string, string>).map(([k, v]) => `${k}: ${v}`).join("; ") : "";
      plaque.classList.add("bad");
      add(
        plaque,
        h("div", null, h("b", null, `Не поднялась${why ? ": " + why : ""}`), h("span", null, `Третьего запуска нет. Причина — в журнале машины ${machine}.`)),
        can("session.start") ? h("button", { class: "cw-b pri", onclick: () => void start() }, "Поднять") : null,
        can("machine.journal") ? h("button", { class: "cw-b", onclick: () => select("log") }, "Почему →") : null,
      );
    } else if (s.state === "waiting" && app.mark("asked", callsign)) {
      const asked = app.mark("asked", callsign) as string;
      plaque.classList.add("wait");
      add(
        plaque,
        h("div", null, h("b", null, `Задаёт вопрос: ${asked}`), h("span", null, "Ответьте в чате ниже или в claude.ai — первый ответ выигрывает.")),
        remote ? h("a", { class: "cw-b", href: remote, target: "_blank", rel: "noopener" }, "Ответить в claude.ai ↗") : null,
      );
    } else if (s.state === "stopped") {
      plaque.classList.add("stop");
      add(
        plaque,
        h("div", null, h("b", null, "Остановлена"), h("span", null, "Разговор цел: «Поднять» продолжит его по resume.")),
        can("session.start") ? h("button", { class: "cw-b pri", onclick: () => void start() }, "Поднять") : null,
      );
    } else return;
    plaque.hidden = false;
  }

  /** Лимит аккаунта сессии в шапке — с 70 %, как прислал accounts. */
  async function loadLimit() {
    if (!can("machine.accounts")) return;
    const r = await app.request<{ accounts: Record<string, { limits?: Record<string, { utilization: number; resetsAt?: number }> }> }>("machine.accounts", { machine });
    const acc = session()?.account;
    if (!r.ok || typeof acc !== "string") return;
    const ws = Object.entries(r.result.accounts?.[acc]?.limits ?? {}).filter(([, w]) => w.utilization >= LIMIT_HINT);
    ws.sort((a, b) => b[1].utilization - a[1].utilization);
    limit = ws[0] ? `${WINDOWS[ws[0][0]] ?? ws[0][0]} ${Math.round(ws[0][1].utilization * 100)} %` : "";
    drawHead();
  }

  // ───── вкладки ─────
  /** вставки места card.tab, видные этой сессии */
  const placed = () => app.placed("card.tab").filter((t) => t.show({ callsign }));

  function tabList(): Array<[string, string]> {
    const out: Array<[string, string]> = [["chat", "Чат"]];
    for (const t of placed()) out.push([t.screen, t.label]);
    out.push(["set", "Настройки"]);
    if (can("machine.journal")) out.push(["log", "Журнал машины"]);
    return out;
  }

  function drawTabs() {
    tabs.textContent = "";
    for (const [k, label] of tabList()) tabs.append(h("button", { role: "tab", "aria-selected": tab === k ? "true" : "false", "data-tab": k, onclick: () => select(k) }, label));
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
    drawTabs();
    if (tab === "chat") inner = app.open("chat", { callsign }, place);
    else if (placed().some((t) => t.screen === tab)) inner = app.open(tab, { callsign }, place);
    else if (tab === "log") own = mountLog();
    else {
      tab = "set";
      drawTabs();
      own = mountSet();
    }
  }

  // ───── настройки ─────
  function mountSet(): ScreenHandle {
    const box = h("div", { class: "cw-set" });
    place.append(box);
    const s0 = session();
    const form: { model?: string; effort?: string; fast?: boolean; style?: string; title?: string } = {};
    const notes: Record<string, { text: string; tone: string }> = {};
    let spec: Spec | null = null;
    let slots: string[] | null = null;
    let profiles: string[] | null = null;
    let ctx: number | null = null;
    let mcp: Mcp[] | null = null;
    let agents: string[] | null = null;
    let slotPick: string | undefined;
    let profilePick: string | undefined;

    const note = (k: string, text: string, tone = "") => {
      notes[k] = { text, tone };
      draw();
    };

    async function load() {
      const jobs: Array<Promise<void>> = [];
      if (can("session.spec")) {
        jobs.push(
          app.request<Spec>("session.spec", { callsign }).then((r) => {
            if (r.ok) spec = r.result;
          }),
        );
      }
      if (can("machine.slots")) {
        jobs.push(
          app.request<{ slots: Record<string, unknown> }>("machine.slots", { machine }).then((r) => {
            if (r.ok) slots = Object.keys(r.result.slots ?? {});
          }),
        );
      }
      if (can("machine.profiles")) {
        jobs.push(
          app.request<{ profiles: Record<string, unknown> }>("machine.profiles", { machine }).then((r) => {
            if (r.ok) profiles = Object.keys(r.result.profiles ?? {});
          }),
        );
      }
      if (can("session.call") && LIVE.has(String(s0?.state))) {
        const call = <T>(method: string) => app.request<T>("session.call", { callsign, method, args: [] });
        jobs.push(
          call<{ percentage?: number }>("getContextUsage").then((r) => {
            if (r.ok) ctx = r.result?.percentage ?? null;
          }),
          call<Mcp[]>("mcpServerStatus").then((r) => {
            if (r.ok && Array.isArray(r.result)) mcp = r.result;
          }),
          call<Array<{ name?: string } | string>>("supportedAgents").then((r) => {
            if (r.ok && Array.isArray(r.result)) agents = r.result.map((a) => (typeof a === "string" ? a : String(a.name)));
          }),
        );
      }
      // каждый ответ — сразу на экран: владелец, который молчит, не держит остальных
      await Promise.all(jobs.map((j) => j.then(draw)));
    }

    async function apply() {
      const s = session();
      const body: Record<string, unknown> = { callsign };
      if (form.model && form.model !== s?.model) body.model = form.model;
      if (form.effort && form.effort !== s?.effort) body.effort = form.effort;
      if (form.fast !== undefined) body.fast = form.fast;
      if (form.style !== undefined) body.style = form.style;
      if (form.title !== undefined && form.title !== (spec?.title ?? "")) body.title = form.title;
      if (Object.keys(body).length === 1) return note("upd", "Нечего применять — всё как сейчас.");
      note("upd", "Применяю…");
      const r = await app.request<{ now?: string[] }>("session.update", body);
      if (!r.ok) return note("upd", `Не применено: ${msg(r)}`, "bad");
      const now = r.result?.now ?? [];
      const later = Object.keys(body).filter((k) => k !== "callsign" && !now.includes(k));
      // новые значения покажет следующий roster, форма сбрасывается
      for (const k of Object.keys(form)) delete form[k as keyof typeof form];
      note("upd", [now.length ? `${now.join(", ")} — сразу, ход не прерван` : "", later.length ? `${later.join(", ")} — со следующего хода` : ""].filter(Boolean).join(" · "), "ok");
    }

    async function move(name: "session.slot" | "session.profile", value: string | null) {
      const key = name === "session.slot" ? "slot" : "profile";
      note(key, "Отправляю…");
      const r = await app.request<{ restart?: boolean }>(name, { callsign, [key]: value });
      if (!r.ok) return note(key, `Не вышло: ${msg(r)}`, "bad");
      note(key, r.result?.restart ? "после конца хода — сессия перейдёт между ходами" : "сразу", "ok");
    }

    async function mcpCall(method: string, args: unknown[]) {
      const r = await app.request("session.call", { callsign, method, args });
      if (!r.ok) return note("mcp", `${method}: ${msg(r)}`, "bad");
      const st = await app.request<Mcp[]>("session.call", { callsign, method: "mcpServerStatus", args: [] });
      if (st.ok && Array.isArray(st.result)) mcp = st.result;
      note("mcp", "");
    }

    async function act(name: "session.stop" | "session.start" | "session.remove") {
      note("ctl", "Отправляю…");
      const r = await app.request(name, { callsign });
      if (!r.ok) return note("ctl", `${name}: ${msg(r)}`, "bad");
      if (name === "session.remove") return app.back();
      note("ctl", "");
    }

    const chips = (list: string[], cur: string | undefined, pick: (v: string) => void, disabled = false) =>
      list.map((v) => h("button", { class: "cw-b", "aria-pressed": cur === v ? "true" : "false", disabled, "data-v": v, onclick: () => pick(v) }, v));
    const noteEl = (k: string) => (notes[k]?.text ? h("div", { class: `cw-note ${notes[k].tone}`, role: "status" }, notes[k].text) : null);

    function draw() {
      const s = session();
      const keep = document.activeElement instanceof HTMLInputElement && box.contains(document.activeElement) ? document.activeElement.dataset.f : undefined;
      box.textContent = "";
      const model = form.model ?? (s?.model as string | undefined);
      const effort = form.effort ?? (s?.effort as string | undefined);
      const isLive = LIVE.has(String(s?.state));
      const style = h("input", { class: "cw-in", "data-f": "style", placeholder: "default", value: form.style ?? "" }) as HTMLInputElement;
      style.addEventListener("input", () => (form.style = style.value));
      const title = h("input", { class: "cw-in", "data-f": "title", placeholder: "заголовок в claude.ai и истории", value: form.title ?? spec?.title ?? "" }) as HTMLInputElement;
      title.addEventListener("input", () => (form.title = title.value));
      if (can("session.update")) {
        box.append(
          h(
            "section",
            { class: "cw-sec", "data-sec": "update" },
            h("h4", { class: "cw-h4" }, "модель и ответ · session.update"),
            h("div", { class: "cw-row" }, h("span", null, "модель"), h("div", { class: "cw-opts" }, chips(MODELS, model, (v) => ((form.model = v), draw())))),
            h("div", { class: "cw-row" }, h("span", null, "усилие"), h("div", { class: "cw-opts" }, chips(EFFORTS, effort, (v) => ((form.effort = v), draw())))),
            h("div", { class: "cw-row" }, h("span", null, "быстрый"), h("div", { class: "cw-opts" }, chips(["выкл", "вкл"], form.fast === undefined ? undefined : form.fast ? "вкл" : "выкл", (v) => ((form.fast = v === "вкл"), draw())))),
            h("div", { class: "cw-row" }, h("span", null, "стиль"), style),
            h("div", { class: "cw-row" }, h("span", null, "заголовок"), title),
            h("div", { class: "cw-opts" }, h("button", { class: "cw-b pri", onclick: () => void apply() }, "Применить"), h("span", { class: "cw-note" }, "модель и усилие — сразу, ход не прерван · стиль — сразу")),
            noteEl("upd"),
          ),
        );
      }
      const slotNow = (s?.slot as { name?: string } | null | undefined)?.name ?? "";
      const profNow = (s?.profile as { id?: string } | null | undefined)?.id ?? "";
      const sel = (list: string[], cur: string, none: string, on: (v: string) => void, f: string) => {
        const e = h("select", { class: "cw-in", "data-f": f }, h("option", { value: "" }, none), list.map((v) => h("option", { value: v, selected: v === cur }, v))) as HTMLSelectElement;
        e.addEventListener("change", () => on(e.value));
        return e;
      };
      box.append(
        h(
          "section",
          { class: "cw-sec", "data-sec": "where" },
          h("h4", { class: "cw-h4" }, "где работает"),
          can("session.slot")
            ? h(
                "div",
                { class: "cw-row" },
                h("span", null, "слот"),
                h(
                  "div",
                  { class: "cw-opts" },
                  sel(slots ?? (slotNow ? [slotNow] : []), slotPick ?? slotNow, "без слота — вход машины", (v) => ((slotPick = v), draw()), "slot"),
                  (slotPick ?? slotNow) !== slotNow ? h("button", { class: "cw-b", onclick: () => void move("session.slot", slotPick || null) }, "Перевести") : null,
                  s?.account ? h("span", { class: "cw-note" }, `аккаунт ${s.account}`) : null,
                ),
              )
            : null,
          noteEl("slot"),
          can("session.profile")
            ? h(
                "div",
                { class: "cw-row" },
                h("span", null, "профиль"),
                h(
                  "div",
                  { class: "cw-opts" },
                  sel(profiles ?? (profNow ? [profNow] : []), profilePick ?? profNow, "без профиля", (v) => ((profilePick = v), draw()), "profile"),
                  (profilePick ?? profNow) !== profNow ? h("button", { class: "cw-b", onclick: () => void move("session.profile", profilePick || null) }, "Сменить") : null,
                ),
              )
            : null,
          noteEl("profile"),
          h("div", { class: "cw-row" }, h("span", null, "папка"), h("span", { class: "cw-mono" }, spec?.dir ?? "—")),
          h("div", { class: "cw-row" }, h("span", null, "позывной"), h("span", { class: "cw-mono" }, `${callsign} · не меняется`)),
        ),
      );
      if (can("session.call") && isLive) {
        box.append(
          h(
            "section",
            { class: "cw-sec", "data-sec": "call" },
            h("h4", { class: "cw-h4" }, "сведения · session.call"),
            h("div", { class: "cw-row" }, h("span", null, "контекст"), h("span", { class: "cw-mono" }, ctx === null ? "—" : `${Math.round(ctx)} %`)),
            ...(mcp ?? []).map((m) =>
              h(
                "div",
                { class: "cw-row" },
                h("span", { class: "cw-mono" }, m.name),
                h(
                  "div",
                  { class: "cw-opts" },
                  h("span", { class: "cw-note" }, m.status ?? ""),
                  h("button", { class: "cw-b", onclick: () => void mcpCall("toggleMcpServer", [m.name, m.status === "disabled"]) }, m.status === "disabled" ? "вкл" : "выкл"),
                  m.status !== "connected" && m.status !== "disabled" ? h("button", { class: "cw-b", onclick: () => void mcpCall("reconnectMcpServer", [m.name]) }, "переподключить") : null,
                ),
              ),
            ),
            noteEl("mcp"),
            agents ? h("div", { class: "cw-row" }, h("span", null, "субагенты"), h("span", { class: "cw-mono" }, agents.join(" · ") || "—")) : null,
          ),
        );
      }
      const stopped = s?.state === "stopped" || s?.state === "failed";
      box.append(
        h(
          "section",
          { class: "cw-sec", "data-sec": "ctl" },
          h("h4", { class: "cw-h4" }, "управление"),
          h(
            "div",
            { class: "cw-opts" },
            s?.state === "busy" && can("session.call") ? h("button", { class: "cw-b bad", onclick: () => void interrupt() }, "■ Прервать") : null,
            s && isLive && can("session.stop") ? h("button", { class: "cw-b", onclick: () => void act("session.stop") }, "Стоп") : null,
            s && stopped && can("session.start") ? h("button", { class: "cw-b pri", onclick: () => void act("session.start") }, "Поднять") : null,
            s && can("session.remove") && !forget ? h("button", { class: "cw-b bad", onclick: () => ((forget = true), draw()) }, "Забыть…") : null,
          ),
          forget
            ? h(
                "div",
                { class: "cw-opts" },
                h("span", { class: "cw-note" }, `Забыть ${callsign}? Сессия уйдёт из списка; если она была в R2, её точки останутся в «Точках».`),
                h("button", { class: "cw-b", onclick: () => ((forget = false), draw()) }, "Отмена"),
                h("button", { class: "cw-b bad", onclick: () => void act("session.remove") }, "Забыть"),
              )
            : null,
          h("div", { class: "cw-note" }, "Стоп — после текущей команды, разговор цел. Забыть — сессия уходит из списка; если она была в R2, её точки остаются в «Точках» как «только в R2»."),
          noteEl("ctl"),
        ),
      );
      if (keep) (box.querySelector(`[data-f="${keep}"]`) as HTMLElement | null)?.focus();
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
          { class: "cw-opts" },
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
      box.append(h("button", { class: "cw-b", onclick: () => ((days += 1), reload()) }, "ещё раньше — с прошлого дня"));
      box.append(h("div", { class: "cw-note" }, `Записи host и keeper машины ${machine} с этим позывным — как в файлах. Журнал флота — раздел «Журнал флота».`));
    }
    reload();
    return {};
  }

  drawHead();
  drawPlaque();
  openTab();
  void loadLimit();
  return {
    head: () => {
      const s = session();
      if (!s) return { title: callsign, mono: true, sub: `${machine} не на связи` };
      const st = stateLabel(s.state);
      return { title: callsign, mono: true, sub: [s.model, s.effort].filter(Boolean).join(" · "), pill: { text: st.text, tone: st.tone } };
    },
    refresh: () => {
      drawHead();
      drawPlaque();
      const want = tabList().map(([k]) => k).join();
      if (want !== [...tabs.children].map((b) => (b as HTMLElement).dataset.tab).join()) drawTabs();
      own?.refresh?.();
    },
    close: () => inner?.close?.(),
  };
}
