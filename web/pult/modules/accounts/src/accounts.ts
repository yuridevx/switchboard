// pult-accounts — аккаунты Claude флота, вход по ссылке и коду, слоты горячей подмены.
// Ничего не считает за владельцев: окна — как прислал accounts машины, кто в слоте — как прислал slots.
// Пульт только пересылает расход почты, увиденный одной машиной, другим её машинам (account.usage).
import { h, hhmm, plural, type App, type AppModule, type Roster, type ScreenHandle } from "@switchboard/web-core";
import { machineOf } from "@switchboard/protocol";

type Window = { utilization: number; resetsAt?: number; at?: number; src?: string };
type Account = { login: "ok" | "none" | "pending"; links?: string[]; email?: string; plan?: string; checked?: number; limits?: Record<string, Window>; err?: string };
type Slot = { account: string | null; order: string[]; wait: number | null; sessions: string[] };
type Login = { machine: string; account: string; phase: "wait" | "url" | "code" | "ok" | "bad" | "err"; url?: string; email?: string; plan?: string; err?: string };
type Dlg = null | { kind: "new"; machine: string; name: string; err: string } | { kind: "sess"; machine: string; slot: string } | { kind: "rm"; machine: string; account: string };

const CSS = `
.ac-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:12px}
.ac-hd{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
.ac-hd b{font:600 15px var(--mono)}
.ac-w{display:grid;grid-template-columns:56px minmax(0,1fr) 120px;gap:8px;align-items:center;font-size:13px}
.ac-w em{font:600 12px var(--mono);font-style:normal}
.ac-m{display:grid;grid-template-columns:70px minmax(0,1fr) auto;gap:8px;align-items:center;font-size:13px;border-top:1px solid var(--line2);padding-top:7px}
.ac-m b{font:600 12.5px var(--mono)}
.ac-ord{display:flex;align-items:center;gap:8px;font-size:13px}
.ac-ord b{font:600 12.5px var(--mono);min-width:70px}
`;

/** Окна лимитов: подпись. */
const WIN: Record<string, string> = { five_hour: "5 ч", seven_day: "неделя", seven_day_opus: "неделя opus", seven_day_sonnet: "неделя sonnet" };
/** Откуда окно: событие сессии, опрос claude или расход с другой машины. */
const SRC: Record<string, string> = { event: "по ответу сессии", poll: "спросили claude" };
/** Слова отказа slots и accounts → строка на экране. */
const WORDS: Record<string, string> = {
  no_reserve: "В запасе нет вошедшего ниже порога — слот прежний",
  has_sessions: "В слоте есть сессии — сначала переведите их",
  no_account: "Такого аккаунта нет на машине",
  no_slot: "Такого слота нет",
  in_slot: "Аккаунт в слоте — сначала смените его в слоте",
  bad_code: "Код не принят — вход закрыт",
  not_started: "Вход прервался: Host перезапускался",
  not_logged_in: "У аккаунта нет входа",
  refresh_locked: "Claude сейчас обновляет вход этого аккаунта — повторите через минуту",
  slot_dir_busy: "На месте слота на машине папка с файлами — разберите её",
};
const say = (w: string) => WORDS[w] ?? w;
const own = (w: Window) => w.src === "event" || w.src === "poll";
const NAME = /^[A-Za-z0-9_-]+$/;

function ago(sec?: number): string {
  if (!sec) return "";
  const m = Math.round((Date.now() / 1000 - sec) / 60);
  if (m < 1) return "сейчас";
  if (m < 60) return `${m} мин назад`;
  return `${Math.round(m / 60)} ч назад`;
}

/** Новый модуль со своей памятью (в выпуске — один; в тестах — на каждый прогон). */
export function createAccounts(): AppModule {
  let app: App;
  const accs = new Map<string, Record<string, Account>>();
  const slots = new Map<string, Record<string, Slot>>();
  const logins = new Map<string, Login>();
  const prevAccount = new Map<string, string>();
  /** «машина · запрос» → слово отказа владельца при загрузке */
  const refused = new Map<string, string>();
  const screens = new Set<{ draw(): void }>();

  const can = (m: string, n: string) => app.provides(m)?.[n] !== undefined;
  const machines = (n: string) => (app.roster()?.machines ?? []).filter((m) => m.contract?.[n] !== undefined).map((m) => m.machine);
  const redraw = () => {
    for (const s of screens) s.draw();
    app.changed();
  };

  async function loadAccounts(m: string, maxAge?: number) {
    const r = await app.request<{ accounts: Record<string, Account> }>("machine.accounts", { machine: m, ...(maxAge ? { max_age: maxAge } : {}) });
    if (r.ok) accs.set(m, r.result.accounts ?? {});
    refusal(m, "machine.accounts", r);
  }
  async function loadSlots(m: string) {
    const r = await app.request<{ slots: Record<string, Slot> }>("machine.slots", { machine: m });
    if (r.ok) slots.set(m, r.result.slots ?? {});
    refusal(m, "machine.slots", r);
  }
  /** Отказ владельца — словом на экране, а не «аккаунтов нет»; ответ снимает его. */
  function refusal(m: string, n: string, r: { ok: boolean; error?: string }) {
    if (r.ok) refused.delete(`${m} · ${n}`);
    else refused.set(`${m} · ${n}`, String(r.error));
  }
  const refusals = (n: string) => [...refused].filter(([k]) => k.endsWith(n)).map(([k, w]) => h("div", { class: "sb-note bad", role: "alert", "data-refused": k }, `${k}: ${w}`));

  /** Открыли экран: каждой машине — machine.accounts { max_age: 120 } и machine.slots; затем расход почты — её машинам. */
  /** первый ответ machine.accounts ещё не пришёл: опрос лимитов занимает секунды — экран пишет «загружаю», а не «нет» */
  let loaded = false;
  /** машины, чьи аккаунты и слоты уже взяты: новая в roster — догрузить */
  const known = new Set<string>();

  async function loadAll() {
    for (const m of [...machines("machine.accounts"), ...machines("machine.slots")]) known.add(m);
    await Promise.all([...machines("machine.accounts").map((m) => loadAccounts(m, 120)), ...machines("machine.slots").map((m) => loadSlots(m))]);
    loaded = true;
    redraw();
    await forward();
  }

  /** Расход, который машина видела сама (event, poll), — другим машинам с той же почтой; src — имя машины. */
  async function forward() {
    const byEmail = new Map<string, Array<{ machine: string; name: string; a: Account }>>();
    for (const [m, list] of accs) {
      for (const [name, a] of Object.entries(list)) {
        if (!a.email) continue;
        byEmail.set(a.email, [...(byEmail.get(a.email) ?? []), { machine: m, name, a }]);
      }
    }
    const sends: Array<Promise<unknown>> = [];
    for (const list of byEmail.values()) {
      for (const src of list) {
        const groups = new Map<number, Record<string, { utilization: number; resetsAt?: number }>>();
        for (const [k, w] of Object.entries(src.a.limits ?? {})) {
          if (!own(w) || typeof w.at !== "number") continue;
          groups.set(w.at, { ...(groups.get(w.at) ?? {}), [k]: { utilization: w.utilization, resetsAt: w.resetsAt } });
        }
        for (const dst of list) {
          if (dst.machine === src.machine || !can(dst.machine, "account.usage")) continue;
          for (const [at, windows] of groups) sends.push(app.request("account.usage", { machine: dst.machine, account: dst.name, src: src.machine, at, windows }));
        }
      }
    }
    await Promise.all(sends);
  }

  /** Подмену делает Host: у сессий машины сменился account — перечитать её слоты и окна. */
  function onRoster(r: Roster) {
    const changed = new Set<string>();
    for (const s of r.sessions) {
      if (typeof s.account !== "string") continue;
      const was = prevAccount.get(s.callsign);
      if (was !== undefined && was !== s.account) changed.add(machineOf(s.callsign) ?? "");
      prevAccount.set(s.callsign, s.account);
    }
    if (!screens.size) return;
    // машина пришла своим соединением позже — взять её аккаунты и слоты
    for (const m of new Set([...machines("machine.accounts"), ...machines("machine.slots")])) {
      if (known.has(m)) continue;
      known.add(m);
      changed.add(m);
    }
    for (const m of changed) {
      if (!m) continue;
      void Promise.all([can(m, "machine.slots") ? loadSlots(m) : null, can(m, "machine.accounts") ? loadAccounts(m) : null]).then(redraw);
    }
  }

  // ───── вход ─────
  async function login(m: string, account: string) {
    const key = `${m}:${account}`;
    logins.set(key, { machine: m, account, phase: "wait" });
    redraw();
    const r = await app.request<{ url: string }>("machine.login", { machine: m, account });
    logins.set(key, r.ok ? { machine: m, account, phase: "url", url: r.result.url } : { machine: m, account, phase: "err", err: r.error });
    redraw();
  }

  async function code(l: Login, value: string) {
    const c = value.trim();
    if (!c) return;
    l.phase = "code";
    redraw();
    // код — как есть, по TLS через relay только этой машине; в хранилище страницы его нет
    const r = await app.request<{ email: string; plan: string }>("machine.login_code", { machine: l.machine, account: l.account, code: c });
    if (r.ok) {
      Object.assign(l, { phase: "ok", email: r.result.email, plan: r.result.plan });
      await loadAccounts(l.machine);
    } else Object.assign(l, { phase: r.error === "bad_code" ? "bad" : "err", err: r.error });
    redraw();
  }

  function loginCard(l: Login): HTMLElement {
    const key = `${l.machine}:${l.account}`;
    const hide = h("button", { class: "sb-b", onclick: () => (logins.delete(key), redraw()) }, "Скрыть");
    const again = h("button", { class: "sb-b pri", onclick: () => void login(l.machine, l.account) }, "Войти заново");
    const head = h("div", { class: "sb-ph" }, h("b", null, `Вход: ${l.account} на ${l.machine}`), hide);
    if (l.phase === "wait") return h("section", { class: "sb-sec dlg", "data-login": key }, head, h("div", { class: "sb-note" }, `Host ${l.machine} запускает вход…`));
    if (l.phase === "url" || l.phase === "code") {
      const inp = h("input", { class: "sb-in m", "data-f": "code", placeholder: "Код со страницы", autocomplete: "off", disabled: l.phase === "code" }) as HTMLInputElement;
      return h(
        "section",
        { class: "sb-sec dlg", "data-login": key },
        head,
        h("div", null, "Откройте ", h("a", { href: l.url ?? "#", target: "_blank", rel: "noopener" }, "страницу входа ↗"), " и войдите в нужный аккаунт Claude."),
        h("div", { class: "sb-opts" }, inp, h("button", { class: "sb-b pri", disabled: l.phase === "code", onclick: () => void code(l, inp.value) }, "Отправить")),
        h("div", { class: "sb-note" }, l.phase === "code" ? `Код отправлен ${l.machine} — ждём ответа claude…` : `Код уходит по TLS через relay только машине ${l.machine}; пульт его не хранит.`),
      );
    }
    if (l.phase === "ok") {
      return h(
        "section",
        { class: "sb-sec ok", "data-login": key },
        head,
        h("b", null, `Вошёл: ${l.email} · ${l.plan}`),
        h("div", { class: "sb-note" }, `Вход — в папке ${l.account} на ${l.machine}. Вход машины и ваш Claude Code не тронуты.`),
      );
    }
    return h("section", { class: "sb-sec bad", "data-login": key }, head, h("b", null, say(l.err ?? "")), l.phase === "bad" ? h("div", { class: "sb-note" }, "Код одноразовый: нужен новый вход.") : h("div", { class: "sb-note" }, `слово: ${l.err}`), h("div", { class: "sb-opts" }, again));
  }

  // ───── окна ─────
  function windows(a: Account | undefined): HTMLElement[] {
    return Object.entries(a?.limits ?? {}).map(([k, w]) => {
      const pct = Math.round(w.utilization * 100);
      return h(
        "div",
        { class: "ac-w", "data-window": k },
        h("span", null, WIN[k] ?? k),
        h("span", { class: "sb-barw" + (pct >= 90 ? " bad" : pct >= 70 ? " warn" : "") }, h("i", { style: `width:${Math.min(100, pct)}%` })),
        h("em", null, `${pct} %${w.resetsAt ? " · до " + hhmm(w.resetsAt * 1000) : ""}`),
      );
    });
  }

  function mount(el: HTMLElement, params: Record<string, string>): ScreenHandle {
    const box = h("div", { class: "sb-page" });
    el.append(box);
    let view = params.view === "slots" ? "slots" : "accounts";
    let dlg: Dlg = params.machine && can(params.machine, "machine.login") ? { kind: "new", machine: params.machine, name: "", err: "" } : null;
    let slotMachine = params.machine && can(params.machine, "machine.slots") ? params.machine : (machines("machine.slots")[0] ?? "");
    // машина из адреса может прийти позже первого roster: выбрать её, пока человек не выбрал другую
    let slotChosen = slotMachine === params.machine;
    const notes = new Map<string, { text: string; tone: string }>();
    const note = (k: string, text: string, tone = "") => {
      notes.set(k, { text, tone });
      draw();
    };
    const noteEl = (k: string) => (notes.get(k)?.text ? h("div", { class: `sb-note ${notes.get(k)!.tone}`, role: "status", "data-note": k }, notes.get(k)!.text) : null);

    // ───── действия слотов ─────
    async function swap(m: string, slot: string, account: string) {
      note(`swap:${m}:${slot}`, "Меняю…");
      const r = await app.request<{ from: string | null; to: string }>("slot.swap", { machine: m, slot, ...(account ? { account } : {}) });
      if (!r.ok) return note(`swap:${m}:${slot}`, say(r.error), "bad");
      const sl = slots.get(m)?.[slot];
      if (sl) sl.account = r.result.to;
      note(`swap:${m}:${slot}`, `${r.result.from ?? "—"} → ${r.result.to}`, "ok");
      app.changed();
    }
    async function setOrder(m: string, slot: string, order: string[]) {
      note(`set:${m}:${slot}`, "Сохраняю…");
      const r = await app.request<{ account: string | null }>("slot.set", { machine: m, slot, order });
      if (!r.ok) return note(`set:${m}:${slot}`, say(r.error), "bad");
      await loadSlots(m);
      note(`set:${m}:${slot}`, order.length ? "порядок сохранён" : `слот ${slot} удалён`, "ok");
    }
    async function moveSessions(m: string, list: string[], target: string) {
      const out: string[] = [];
      for (const callsign of list) {
        const r = await app.request<{ restart: boolean }>("session.slot", { callsign, slot: target || null });
        out.push(`${callsign}: ${r.ok ? (r.result.restart ? "перейдёт между ходами" : "перешла") : say(r.error)}`);
      }
      await loadSlots(m);
      note(`move:${m}`, out.join(" · "), "ok");
    }
    /** Слоты машины, где аккаунт стоит сейчас: один аккаунт может стоять в нескольких. */
    function slotsOf(m: string, account: string): string[] {
      return Object.entries(slots.get(m) ?? {})
        .filter(([, s]) => s.account === account)
        .map(([n]) => n);
    }
    /** Пометка «сейчас и в слоте …» — аккаунт стоит и в других слотах машины, лимит у них общий. */
    function shared(m: string, account: string, except: string): HTMLElement | null {
      const other = slotsOf(m, account).filter((n) => n !== except);
      return other.length ? h("span", { class: "sb-note", "data-shared": other.join(",") }, ` · сейчас и в ${other.length > 1 ? "слотах" : "слоте"} ${other.join(", ")}`) : null;
    }
    async function remove(m: string, account: string, pickNext: string) {
      const k = `rm:${m}:${account}`;
      const list = slots.get(m) ?? {};
      // пульт складывает шаги сам — запросы по контракту, каждый после ответа предыдущего
      for (const inSlot of slotsOf(m, account)) {
        note(k, `слот ${inSlot}: смена аккаунта…`);
        const next = pickNext && list[inSlot].order.includes(pickNext) ? pickNext : "";
        const r = await app.request<{ from: string; to: string }>("slot.swap", { machine: m, slot: inSlot, ...(next ? { account: next } : {}) });
        if (!r.ok) return note(k, `слот ${inSlot}: ${say(r.error)}`, "bad");
      }
      for (const [name, s] of Object.entries(list)) {
        if (!s.order.includes(account)) continue;
        const r = await app.request("slot.set", { machine: m, slot: name, order: s.order.filter((x) => x !== account) });
        if (!r.ok) return note(k, `slot.set ${name}: ${say(r.error)}`, "bad");
      }
      const r = await app.request<{ wiped: boolean }>("machine.account_remove", { machine: m, account });
      if (!r.ok) return note(k, say(r.error), "bad");
      dlg = null;
      await Promise.all([loadAccounts(m), loadSlots(m)]);
      note(k, `${account} удалён с ${m}`, "ok");
    }

    // ───── вид «Аккаунты» ─────
    function drawAccounts() {
      const pending = [...logins.values()];
      box.append(...pending.map(loginCard));
      if (dlg?.kind === "new") box.append(drawNew(dlg));
      const groups = new Map<string, Array<{ machine: string; name: string; a: Account }>>();
      for (const [m, list] of accs) {
        for (const [name, a] of Object.entries(list)) {
          const key = a.email ?? `name:${name}`;
          groups.set(key, [...(groups.get(key) ?? []), { machine: m, name, a }]);
        }
      }
      const sessions = app.roster()?.sessions ?? [];
      const cards = [...groups].map(([key, list]) => {
        const first = list[0].a;
        const n = sessions.filter((s) => list.some((x) => x.machine === machineOf(s.callsign) && x.name === s.account)).length;
        // окна — запись одной машины, как пришла: первая машина, у которой они есть
        const src = list.find((x) => Object.keys(x.a.limits ?? {}).length);
        const w0 = src ? Object.values(src.a.limits ?? {})[0] : undefined;
        return h(
          "section",
          { class: "sb-sec", "data-account": key },
          h("div", { class: "ac-hd" }, h("b", null, first.email ?? list[0].name), first.plan ? h("span", { class: "sb-pill busy" }, first.plan) : first.email ? null : h("span", { class: "sb-note" }, "почта — после входа"), h("span", { class: "sb-note" }, `${n} ${plural(n, "сессия", "сессии", "сессий")}`)),
          src ? windows(src.a) : null,
          src && w0 ? h("div", { class: "sb-note" }, [SRC[w0.src ?? ""] ?? `от ${w0.src}`, src.machine, ago(w0.at)].filter(Boolean).join(" · ")) : null,
          list.map((x) => machineRow(x.machine, x.name, x.a)),
          ...list.map((x) => noteEl(`rm:${x.machine}:${x.name}`)),
          ...list.filter((x) => dlg?.kind === "rm" && dlg.machine === x.machine && dlg.account === x.name).map((x) => drawRm(x.machine, x.name)),
          ...list.flatMap((x) => Object.entries(slots.get(x.machine) ?? {}).filter(([n, s]) => s.account === x.name && dlg?.kind === "sess" && dlg.machine === x.machine && dlg.slot === n).map(([n]) => drawSess(x.machine, n))),
        );
      });
      box.append(h("div", { class: "ac-cards" }, cards));
      box.append(...refusals("machine.accounts"));
      if (!groups.size && !refusals("machine.accounts").length) box.append(h("div", { class: "sb-note" }, loaded ? "Аккаунтов нет — «+ Новый аккаунт»." : "Загружаю аккаунты машин…"));
      box.append(h("div", { class: "sb-note" }, "Одна карточка — одна почта со всех машин. Окна — запись Host одной машины; свежее из всех источников выбирает он сам."));
    }

    function machineRow(m: string, name: string, a: Account): HTMLElement {
      const list = slots.get(m) ?? {};
      const inSlots = slotsOf(m, name);
      const reserve = Object.entries(list).find(([, s]) => s.account !== name && s.order.includes(name))?.[0];
      const st = a.login === "ok" ? "вошёл" : a.login === "pending" ? "вход идёт" : "нет входа";
      return h(
        "div",
        { class: "ac-m", "data-machine": m },
        h("b", null, m),
        h("span", null, h("span", { class: `sb-note ${a.login === "ok" ? "ok" : "wait"}` }, st), " ", inSlots.length ? `${inSlots.length > 1 ? "в слотах" : "в слоте"} ${inSlots.join(", ")}` : reserve ? `запас ${reserve}` : ""),
        h(
          "span",
          { class: "sb-opts" },
          can(m, "slot.swap")
            ? inSlots.map((sl) => h("button", { class: "sb-b", "data-sess": sl, onclick: () => ((dlg = { kind: "sess", machine: m, slot: sl }), draw()) }, `Сессии${inSlots.length > 1 ? ` ${sl}` : ""} (${list[sl].sessions.length})…`))
            : null,
          a.login !== "ok" && can(m, "machine.login") ? h("button", { class: "sb-b pri", onclick: () => void login(m, name) }, "Войти") : null,
          can(m, "machine.account_remove") ? h("button", { class: "sb-b", onclick: () => ((dlg = { kind: "rm", machine: m, account: name }), draw()) }, "Удалить…") : null,
        ),
      );
    }

    function drawNew(d: Extract<Dlg, { kind: "new" }>): HTMLElement {
      const ms = machines("machine.login");
      const inp = h("input", { class: "sb-in m", "data-f": "account", placeholder: "corp", value: d.name }) as HTMLInputElement;
      inp.addEventListener("input", () => (d.name = inp.value));
      return h(
        "section",
        { class: "sb-sec dlg" },
        h("h4", { class: "sb-h4" }, "Новый аккаунт"),
        h("div", { class: "sb-row" }, h("span", null, "Машина"), h("div", { class: "sb-opts" }, ms.map((m) => h("button", { class: "sb-b", "aria-pressed": d.machine === m ? "true" : "false", onclick: () => ((d.machine = m), draw()) }, m)))),
        h("div", { class: "sb-row" }, h("span", null, "Имя на машине"), inp),
        h("div", { class: "sb-note" }, `латиница, цифры, - и _; из имени — своя папка Claude на ${d.machine}. Почту скажет вход.`),
        d.err ? h("div", { class: "sb-note bad" }, d.err) : null,
        h(
          "div",
          { class: "sb-opts" },
          h("button", { class: "sb-b", onclick: () => ((dlg = null), draw()) }, "Отмена"),
          h(
            "button",
            {
              class: "sb-b pri",
              onclick: () => {
                if (!NAME.test(d.name)) return void ((d.err = "имя — латиница, цифры, - и _"), draw());
                dlg = null;
                void login(d.machine, d.name);
              },
            },
            "Войти",
          ),
        ),
      );
    }

    function drawSess(m: string, slot: string): HTMLElement {
      const s = slots.get(m)![slot];
      const other = s.order.filter((x) => x !== s.account);
      const pickAcc = h("select", { class: "sb-in", "data-f": "swap" }, h("option", { value: "" }, "следующего по порядку — выберет Host"), other.map((x) => h("option", { value: x }, x))) as HTMLSelectElement;
      const targets = Object.keys(slots.get(m) ?? {}).filter((x) => x !== slot);
      const pickSlot = h("select", { class: "sb-in", "data-f": "target" }, targets.map((x) => h("option", { value: x }, x)), h("option", { value: "" }, "без слота — вход машины")) as HTMLSelectElement;
      const checks = s.sessions.map((c) => h("label", { class: "sb-opts" }, h("input", { type: "checkbox", value: c }), c));
      return h(
        "section",
        { class: "sb-sec dlg", "data-dlg": "sess" },
        h("h4", { class: "sb-h4" }, `Сессии слота ${slot} на ${m} · сейчас ${s.account ?? "—"}`),
        h("b", null, "Сменить аккаунт всему слоту"),
        h("div", { class: "sb-note" }, `${s.sessions.map((c) => c.split("@")[0]).join(", ") || "сессии слота"} продолжат тот же ход на новом аккаунте — без перезапуска`),
        h("div", { class: "sb-opts" }, pickAcc, h("button", { class: "sb-b pri", onclick: () => void swap(m, slot, pickAcc.value) }, "Сменить сейчас")),
        noteEl(`swap:${m}:${slot}`),
        h("b", null, "Перевести выбранные в другой слот"),
        h("div", { class: "sb-note" }, "сессия переходит между ходами: закрыть и поднять с тем же разговором"),
        h("div", { class: "sb-opts" }, checks, pickSlot, h("button", { class: "sb-b", onclick: () => void moveSessions(m, checks.map((l) => l.querySelector("input")!).filter((i) => i.checked).map((i) => i.value), pickSlot.value) }, "Перевести")),
        noteEl(`move:${m}`),
        h("div", { class: "sb-opts" }, h("button", { class: "sb-b", onclick: () => ((dlg = null), draw()) }, "Закрыть")),
      );
    }

    function drawRm(m: string, account: string): HTMLElement {
      const list = slots.get(m) ?? {};
      const inSlots = slotsOf(m, account);
      const others = [...new Set(inSlots.flatMap((sl) => list[sl].order.filter((x) => x !== account)))];
      const pick = inSlots.length
        ? (h("select", { class: "sb-in", "data-f": "next" }, h("option", { value: "" }, "следующего по порядку — выберет Host"), others.map((x) => h("option", { value: x }, x))) as HTMLSelectElement)
        : null;
      const sess = inSlots.flatMap((sl) => list[sl].sessions.map((c) => c.split("@")[0]));
      return h(
        "section",
        { class: "sb-sec dlg", "data-dlg": "rm" },
        h("h4", { class: "sb-h4" }, `Удалить ${account} с ${m}`),
        inSlots.length
          ? h(
              "div",
              null,
              h("b", null, `${account} сейчас ${inSlots.length > 1 ? "в слотах" : "в слоте"} ${inSlots.join(", ")}`),
              h("div", { class: "sb-note" }, `Сначала ${inSlots.length > 1 ? "каждый слот сменит" : "слот сменит"} аккаунт — ${sess.join(", ") || "сессии слота"} продолжат на новом, — потом ${account} уйдёт из порядка слотов и удалится.`),
            )
          : null,
        pick ? h("div", { class: "sb-row" }, h("span", null, `Кого положить в ${inSlots.length > 1 ? "слоты" : `слот ${inSlots[0]}`}`), pick) : null,
        h("div", { class: "sb-note" }, `Стирается только папка ${account} на ${m}. Вход машины и другие аккаунты не трогаются.`),
        h(
          "div",
          { class: "sb-opts" },
          h("button", { class: "sb-b", onclick: () => ((dlg = null), draw()) }, "Отмена"),
          h("button", { class: "sb-b bad", onclick: () => void remove(m, account, pick?.value ?? "") }, inSlots.length ? "Сменить и удалить" : "Удалить"),
        ),
      );
    }

    // ───── вид «Слоты» ─────
    function drawSlots() {
      const ms = machines("machine.slots");
      box.append(h("div", { class: "sb-opts" }, ms.map((m) => h("button", { class: "sb-b", "aria-pressed": m === slotMachine ? "true" : "false", onclick: () => ((slotMachine = m), (slotChosen = true), draw()) }, m))));
      const m = slotMachine;
      const list = slots.get(m) ?? {};
      const a = accs.get(m) ?? {};
      box.append(...refusals("machine.slots").filter((x) => x.dataset.refused === `${m} · machine.slots`));
      for (const [name, s] of Object.entries(list)) {
        const pick = h("select", { class: "sb-in", "data-f": `now:${name}` }, h("option", { value: "" }, "следующего по порядку — выберет Host"), s.order.filter((x) => x !== s.account).map((x) => h("option", { value: x }, x))) as HTMLSelectElement;
        const free = Object.keys(a).filter((x) => !s.order.includes(x) && a[x].login === "ok");
        const add = h("select", { class: "sb-in", "data-f": `add:${name}` }, h("option", { value: "" }, "+ аккаунт в запас"), free.map((x) => h("option", { value: x }, x))) as HTMLSelectElement;
        add.addEventListener("change", () => add.value && void setOrder(m, name, [...s.order, add.value]));
        const move = (i: number, d: number) => {
          const o = [...s.order];
          const j = i + d;
          if (j < 0 || j >= o.length) return;
          [o[i], o[j]] = [o[j], o[i]];
          void setOrder(m, name, o);
        };
        box.append(
          h(
            "section",
            { class: "sb-sec", "data-slot": `${m}:${name}` },
            s.wait
              ? h("div", { class: "sb-sec wait" }, h("b", null, `Слот ${name} ждёт сброса · ${hhmm(s.wait * 1000)}`), h("span", { class: "sb-note" }, "Все аккаунты слота у порога. Сессии работают, пока модель не откажет; в час сброса Host сам положит аккаунт и скажет оборванным ходам «Продолжай»."))
              : null,
            h("div", { class: "ac-hd" }, h("b", null, `Слот ${name}`), h("span", { class: "sb-note" }, `${s.sessions.length} ${plural(s.sessions.length, "сессия", "сессии", "сессий")}${s.sessions.length ? ": " + s.sessions.map((c) => c.split("@")[0]).join(", ") : ""}`)),
            h(
              "div",
              { "data-current": s.account ?? "" },
              h("span", { class: "sb-note" }, "в слоте: "),
              h("b", { class: "sb-m" }, s.account ?? "—"),
              ...(s.account ? [shared(m, s.account, name)] : []),
            ),
            windows(s.account ? a[s.account] : undefined),
            h("h4", { class: "sb-h4" }, "Запас — по порядку"),
            s.order.map((x, i) =>
              h(
                "div",
                { class: "ac-ord" },
                h("b", null, x),
                h("span", { class: "sb-note" }, Object.entries(a[x]?.limits ?? {}).map(([k, w]) => `${WIN[k] ?? k} ${Math.round(w.utilization * 100)} %`).join(" · ")),
                shared(m, x, name),
                h("button", { class: "sb-b", "aria-label": `${x} выше`, disabled: i === 0, onclick: () => move(i, -1) }, "↑"),
                h("button", { class: "sb-b", "aria-label": `${x} ниже`, disabled: i === s.order.length - 1, onclick: () => move(i, 1) }, "↓"),
                x !== s.account ? h("button", { class: "sb-b", "aria-label": `убрать ${x}`, onclick: () => void setOrder(m, name, s.order.filter((y) => y !== x)) }, "✕") : null,
              ),
            ),
            h("div", { class: "sb-opts" }, add, !s.sessions.length ? h("button", { class: "sb-b bad", onclick: () => void setOrder(m, name, []) }, "Удалить слот") : null),
            noteEl(`set:${m}:${name}`),
            h("div", { class: "sb-opts" }, pick, h("button", { class: "sb-b pri", "data-act": "swap", onclick: () => void swap(m, name, pick.value) }, "Сменить сейчас")),
            noteEl(`swap:${m}:${name}`),
            h("div", { class: "sb-note" }, "у порога Host меняет сам; окна — от accounts"),
          ),
        );
      }
      if (m) {
        const nm = h("input", { class: "sb-in m", "data-f": "newslot", placeholder: "имя слота" }) as HTMLInputElement;
        const acc = h("select", { class: "sb-in" }, Object.keys(a).filter((x) => a[x].login === "ok").map((x) => h("option", { value: x }, x))) as HTMLSelectElement;
        box.append(
          h("section", { class: "sb-sec" }, h("h4", { class: "sb-h4" }, `+ Новый слот на ${m}`), h("div", { class: "sb-opts" }, nm, acc, h("button", { class: "sb-b", onclick: () => nm.value && acc.value && void setOrder(m, nm.value, [acc.value]) }, "Создать")), noteEl(`set:${m}:${nm.value}`)),
        );
      }
      if (!ms.length) box.append(h("div", { class: "sb-note" }, "Нет машин со слотами на связи."));
    }

    function draw() {
      if (!slotChosen && params.machine && can(params.machine, "machine.slots")) {
        slotMachine = params.machine;
        slotChosen = true;
      }
      box.textContent = "";
      box.append(
        h(
          "div",
          { class: "sb-ph" },
          h("h2", null, view === "slots" ? "Слоты" : "Аккаунты"),
          h("button", { class: "sb-b", "aria-pressed": view === "accounts" ? "true" : "false", onclick: () => ((view = "accounts"), draw()) }, "Аккаунты"),
          h("button", { class: "sb-b", "aria-pressed": view === "slots" ? "true" : "false", onclick: () => ((view = "slots"), draw()) }, "Слоты"),
          view === "accounts" && machines("machine.login").length
            ? h("button", { class: "sb-b pri", onclick: () => ((dlg = { kind: "new", machine: machines("machine.login")[0], name: "", err: "" }), draw()) }, "+ Новый аккаунт")
            : null,
        ),
      );
      if (view === "slots") drawSlots();
      else drawAccounts();
    }

    const me = { draw };
    screens.add(me);
    draw();
    void loadAll();
    return {
      head: () => ({ title: "Аккаунты" }),
      close: () => screens.delete(me),
    };
  }

  return {
    on: { roster: onRoster },
    screens: { accounts: { nav: "Аккаунты", mark: "logins", label: "Аккаунты", mount } },
    marks: {
      logins: () => [...accs.values()].reduce((n, list) => n + Object.values(list).filter((a) => a.login === "pending").length, 0),
    },
    css: CSS,
    start(a) {
      app = a;
    },
  };
}
