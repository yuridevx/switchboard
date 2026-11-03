// pult-accounts — аккаунты Claude флота, вход по ссылке и коду, слоты горячей подмены.
// Ничего не считает за владельцев: окна — как прислал accounts машины, кто в слоте — как прислал slots.
// Расход почты на других машинах Host читает у Claude сам, перед подменой; пульт его не пересылает.
import { useEffect, useReducer, useRef, useState, type ComponentProps } from "react";
import type { App, AppModule, Roster, ScreenProps } from "@switchboard/web-core";
import type {} from "@switchboard/web-board";
import { machineOf } from "@switchboard/protocol";
import { Btn, H4, Hint, hhmm, In, LinkBtn, M, Meter, Note, Opts, OptsInline, OptsLabel, Page, PageHead, Pill, PickOne, plural, Row, Sec, Sel } from "@switchboard/web-ui";
import css from "./accounts.css";

type Window = { utilization: number; resetsAt?: number; at?: number; src?: string };
type Account = { login: "ok" | "none" | "pending"; links?: string[]; email?: string; plan?: string; checked?: number; limits?: Record<string, Window>; err?: string };
type Slot = { account: string | null; order: string[]; wait: number | null; sessions: string[] };
type Login = { machine: string; account: string; phase: "wait" | "url" | "code" | "ok" | "bad" | "err"; url?: string; email?: string; plan?: string; err?: string };
type Dlg = null | { kind: "new"; id: number; machine: string; name: string; err: string } | { kind: "sess"; machine: string; slot: string } | { kind: "rm"; machine: string; account: string };
type Tone = "ok" | "bad" | "wait" | undefined;

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
  /** сколько экранов открыто: подмену и новую машину перечитываем только при открытом экране */
  let opened = 0;
  /** номер изменения данных модуля: их читает экран */
  let rev = 0;
  const newIds = { next: 1 };

  const machines = (n: string) => (app.roster()?.machines ?? []).filter((m) => m.contract?.[n] !== undefined).map((m) => m.machine);
  const redraw = () => {
    rev++;
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
  const refusals = (n: string) => [...refused].filter(([k]) => k.endsWith(n));
  const Refused = ({ list }: { list: Array<[string, string]> }) => (
    <>
      {list.map(([k, w]) => (
        <Note key={k} tone="bad" role="alert" data-refused={k}>{`${k}: ${w}`}</Note>
      ))}
    </>
  );

  /** Открыли экран: каждой машине — machine.accounts { max_age: 120 } и machine.slots. */
  /** первый ответ machine.accounts ещё не пришёл: опрос лимитов занимает секунды — экран пишет «загружаю», а не «нет» */
  let loaded = false;
  /** машины, чьи аккаунты и слоты уже взяты: новая в roster — догрузить */
  const known = new Set<string>();

  async function loadAll() {
    for (const m of [...machines("machine.accounts"), ...machines("machine.slots")]) known.add(m);
    await Promise.all([...machines("machine.accounts").map((m) => loadAccounts(m, 120)), ...machines("machine.slots").map((m) => loadSlots(m))]);
    loaded = true;
    redraw();
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
    if (!opened) return;
    // машина пришла своим соединением позже — взять её аккаунты и слоты
    for (const m of new Set([...machines("machine.accounts"), ...machines("machine.slots")])) {
      if (known.has(m)) continue;
      known.add(m);
      changed.add(m);
    }
    for (const m of changed) {
      if (!m) continue;
      void Promise.all([app.can(m, "machine.slots") ? loadSlots(m) : null, app.can(m, "machine.accounts") ? loadAccounts(m) : null]).then(redraw);
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

  /** Ссылка входа — в буфер; браузер отказал — ссылка остаётся на кнопке. */
  async function copy(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      app.toast("Ссылка скопирована", "ok");
    } catch {
      app.toast("Буфер недоступен — откройте ссылку кнопкой");
    }
  }

  function LoginCard({ l }: { l: Login }) {
    const key = `${l.machine}:${l.account}`;
    const inp = useRef<HTMLInputElement>(null);
    const head = (
      <PageHead>
        <b>{`Вход: ${l.account} на ${l.machine}`}</b>
        <Btn
          onClick={() => {
            logins.delete(key);
            redraw();
          }}
        >
          Скрыть
        </Btn>
      </PageHead>
    );
    if (l.phase === "wait") {
      return (
        <Sec dlg data-login={key}>
          {head}
          <Note>{`Host ${l.machine} запускает вход…`}</Note>
        </Sec>
      );
    }
    if (l.phase === "url" || l.phase === "code") {
      return (
        <Sec dlg data-login={key}>
          {head}
          <div className="ac-link">
            <LinkBtn pri href={l.url ?? "#"} target="_blank" rel="noopener">
              Открыть ссылку входа ↗
            </LinkBtn>
            <Btn onClick={() => void copy(l.url ?? "")}>Копировать</Btn>
          </div>
          <Opts>
            <In ref={inp} mono data-f="code" placeholder="Код со страницы" autoComplete="off" disabled={l.phase === "code"} />
            <Btn pri disabled={l.phase === "code"} onClick={() => void code(l, inp.current?.value ?? "")}>
              Отправить
            </Btn>
          </Opts>
          {l.phase === "code" ? <Note>{`ждём ответа ${l.machine}…`}</Note> : null}
        </Sec>
      );
    }
    if (l.phase === "ok") {
      return (
        <Sec tone="ok" data-login={key}>
          {head}
          <b>{`Вошёл: ${l.email} · ${l.plan}`}</b>
        </Sec>
      );
    }
    return (
      <Sec tone="bad" data-login={key}>
        {head}
        <b>{say(l.err ?? "")}</b>
        {l.phase === "bad" ? null : <Note>{`слово: ${l.err}`}</Note>}
        <Opts>
          <Btn pri onClick={() => void login(l.machine, l.account)}>
            Войти заново
          </Btn>
        </Opts>
      </Sec>
    );
  }

  // ───── окна ─────
  function Windows({ a }: { a: Account | undefined }) {
    return (
      <>
        {Object.entries(a?.limits ?? {}).map(([k, w]) => {
          const pct = Math.round(w.utilization * 100);
          return (
            <div key={k} className="ac-w" data-window={k}>
              <span>{WIN[k] ?? k}</span>
              <Meter value={Math.min(100, pct)} bad={pct >= 90} warn={pct < 90 && pct >= 70} />
              <em>{`${pct} %${w.resetsAt ? " · до " + hhmm(w.resetsAt * 1000) : ""}`}</em>
            </div>
          );
        })}
      </>
    );
  }

  /** Состояние открытого экрана и его действия: живут, пока экран открыт; после асинхронного шага зовут draw. */
  function makeScreen(params: ScreenProps["params"], draw: () => void) {
    const sc = {
      params,
      draw,
      view: params.view === "slots" ? "slots" : "accounts",
      dlg: (params.machine && app.can(params.machine, "machine.login") ? { kind: "new", id: newIds.next++, machine: params.machine, name: "", err: "" } : null) as Dlg,
      slotMachine: params.machine && app.can(params.machine, "machine.slots") ? params.machine : (machines("machine.slots")[0] ?? ""),
      // машина из адреса может прийти позже первого roster: выбрать её, пока человек не выбрал другую
      slotChosen: false,
      /** почта, у которой открыт выбор машины для входа */
      pickFor: "",
      notes: new Map<string, { text: string; tone: Tone }>(),
      note(k: string, text: string, tone?: Tone) {
        sc.notes.set(k, { text, tone });
        draw();
      },
      // ───── действия слотов ─────
      async swap(m: string, slot: string, account: string) {
        sc.note(`swap:${m}:${slot}`, "Меняю…");
        const r = await app.request<{ from: string | null; to: string }>("slot.swap", { machine: m, slot, ...(account ? { account } : {}) });
        if (!r.ok) return sc.note(`swap:${m}:${slot}`, say(r.error), "bad");
        const sl = slots.get(m)?.[slot];
        if (sl) sl.account = r.result.to;
        sc.note(`swap:${m}:${slot}`, `${r.result.from ?? "—"} → ${r.result.to}`, "ok");
        app.changed();
      },
      async setOrder(m: string, slot: string, order: string[]) {
        sc.note(`set:${m}:${slot}`, "Сохраняю…");
        const r = await app.request<{ account: string | null }>("slot.set", { machine: m, slot, order });
        if (!r.ok) return sc.note(`set:${m}:${slot}`, say(r.error), "bad");
        await loadSlots(m);
        sc.note(`set:${m}:${slot}`, order.length ? "порядок сохранён" : `слот ${slot} удалён`, "ok");
      },
      async moveSessions(m: string, list: string[], target: string) {
        const out: string[] = [];
        for (const callsign of list) {
          const r = await app.request<{ restart: boolean }>("session.slot", { callsign, slot: target || null });
          out.push(`${callsign}: ${r.ok ? (r.result.restart ? "перейдёт между ходами" : "перешла") : say(r.error)}`);
        }
        await loadSlots(m);
        sc.note(`move:${m}`, out.join(" · "), "ok");
      },
      async remove(m: string, account: string, pickNext: string) {
        const k = `rm:${m}:${account}`;
        const list = slots.get(m) ?? {};
        // пульт складывает шаги сам — запросы по контракту, каждый после ответа предыдущего
        for (const inSlot of slotsOf(m, account)) {
          sc.note(k, `слот ${inSlot}: смена аккаунта…`);
          const next = pickNext && list[inSlot].order.includes(pickNext) ? pickNext : "";
          const r = await app.request<{ from: string; to: string }>("slot.swap", { machine: m, slot: inSlot, ...(next ? { account: next } : {}) });
          if (!r.ok) return sc.note(k, `слот ${inSlot}: ${say(r.error)}`, "bad");
        }
        for (const [name, s] of Object.entries(list)) {
          if (!s.order.includes(account)) continue;
          const r = await app.request("slot.set", { machine: m, slot: name, order: s.order.filter((x) => x !== account) });
          if (!r.ok) return sc.note(k, `slot.set ${name}: ${say(r.error)}`, "bad");
        }
        const r = await app.request<{ wiped: boolean }>("machine.account_remove", { machine: m, account });
        if (!r.ok) return sc.note(k, say(r.error), "bad");
        sc.dlg = null;
        await Promise.all([loadAccounts(m), loadSlots(m)]);
        sc.note(k, `${account} удалён с ${m}`, "ok");
      },
    };
    sc.slotChosen = sc.slotMachine === params.machine;
    return sc;
  }
  type Sc = ReturnType<typeof makeScreen>;

  /** Слоты машины, где аккаунт стоит сейчас: один аккаунт может стоять в нескольких. */
  function slotsOf(m: string, account: string): string[] {
    return Object.entries(slots.get(m) ?? {})
      .filter(([, s]) => s.account === account)
      .map(([n]) => n);
  }

  /** Строка итога действия. */
  function NoteLine({ sc, k }: { sc: Sc; k: string }) {
    const n = sc.notes.get(k);
    return n?.text ? (
      <Note tone={n.tone} role="status" data-note={k}>
        {n.text}
      </Note>
    ) : null;
  }

  /** Пометка «сейчас и в слоте …» — аккаунт стоит и в других слотах машины, лимит у них общий. */
  function Shared({ m, account, except }: { m: string; account: string; except: string }) {
    const other = slotsOf(m, account).filter((n) => n !== except);
    return other.length ? <Hint data-shared={other.join(",")}>{` · сейчас и в ${other.length > 1 ? "слотах" : "слоте"} ${other.join(", ")}`}</Hint> : null;
  }

  /** «＋ войти на машине…»: любая машина на связи, где этой почты ещё нет; имя на машине — то же, что на других. */
  function AnyMachine({ sc, id, list, pm }: { sc: Sc; id: string; list: Array<{ machine: string; name: string; a: Account }>; pm: string[] }) {
    const has = new Set(list.map((x) => x.machine));
    const free = machines("machine.login").filter((m) => !has.has(m));
    if (!free.length) return null;
    const name = list[0].name;
    if (sc.pickFor !== id) {
      return (
        <Opts>
          <Btn
            dash
            data-any={id}
            onClick={() => {
              sc.pickFor = id;
              sc.draw();
            }}
          >
            ＋ войти на машине…
          </Btn>
        </Opts>
      );
    }
    return (
      <Opts data-any-pick={id}>
        {free.map((m) => (
          <Btn
            key={m}
            data-m={m}
            onClick={() => {
              sc.pickFor = "";
              void login(m, name);
            }}
          >
            {pm.includes(m) ? `${m} ★` : m}
          </Btn>
        ))}
        <Btn
          onClick={() => {
            sc.pickFor = "";
            sc.draw();
          }}
        >
          Отмена
        </Btn>
      </Opts>
    );
  }

  function MachineRow({ sc, m, name, a }: { sc: Sc; m: string; name: string; a: Account }) {
    const list = slots.get(m) ?? {};
    const inSlots = slotsOf(m, name);
    const reserve = Object.entries(list).find(([, s]) => s.account !== name && s.order.includes(name))?.[0];
    const st = a.login === "ok" ? "вошёл" : a.login === "pending" ? "вход идёт" : "нет входа";
    return (
      <div className="ac-m" data-machine={m}>
        <b>{m}</b>
        <span>
          <Hint tone={a.login === "ok" ? "ok" : "wait"}>{st}</Hint> {inSlots.length ? `${inSlots.length > 1 ? "в слотах" : "в слоте"} ${inSlots.join(", ")}` : reserve ? `запас ${reserve}` : ""}
        </span>
        <OptsInline>
          {app.can(m, "slot.swap")
            ? inSlots.map((sl) => (
                <Btn
                  key={sl}
                  data-sess={sl}
                  onClick={() => {
                    sc.dlg = { kind: "sess", machine: m, slot: sl };
                    sc.draw();
                  }}
                >
                  {`Сессии${inSlots.length > 1 ? ` ${sl}` : ""} (${list[sl].sessions.length})…`}
                </Btn>
              ))
            : null}
          {a.login !== "ok" && app.can(m, "machine.login") ? (
            <Btn pri onClick={() => void login(m, name)}>
              Войти
            </Btn>
          ) : null}
          {app.can(m, "machine.account_remove") ? (
            <Btn
              onClick={() => {
                sc.dlg = { kind: "rm", machine: m, account: name };
                sc.draw();
              }}
            >
              Удалить…
            </Btn>
          ) : null}
        </OptsInline>
      </div>
    );
  }

  function NewDlg({ sc, d }: { sc: Sc; d: Extract<Dlg, { kind: "new" }> }) {
    const ms = machines("machine.login");
    return (
      <Sec dlg>
        <H4>Новый аккаунт</H4>
        <Row label="Машина">
          <Opts>
            {ms.map((m) => (
              <Btn
                key={m}
                aria-pressed={d.machine === m ? "true" : "false"}
                onClick={() => {
                  d.machine = m;
                  sc.draw();
                }}
              >
                {m}
              </Btn>
            ))}
          </Opts>
        </Row>
        <Row label="Имя на машине">
          <In mono data-f="account" placeholder="corp" defaultValue={d.name} onInput={(e) => (d.name = e.currentTarget.value)} />
        </Row>
        {d.err ? <Note tone="bad">{d.err}</Note> : null}
        <Opts>
          <Btn
            onClick={() => {
              sc.dlg = null;
              sc.draw();
            }}
          >
            Отмена
          </Btn>
          <Btn
            pri
            onClick={() => {
              if (!NAME.test(d.name)) {
                d.err = "имя — латиница, цифры, - и _";
                return sc.draw();
              }
              sc.dlg = null;
              void login(d.machine, d.name);
            }}
          >
            Войти
          </Btn>
        </Opts>
      </Sec>
    );
  }

  function SessDlg({ sc, m, slot }: { sc: Sc; m: string; slot: string }) {
    const pickAcc = useRef<HTMLSelectElement>(null);
    const pickSlot = useRef<HTMLSelectElement>(null);
    const checks = useRef<HTMLDivElement>(null);
    const s = slots.get(m)![slot];
    const other = s.order.filter((x) => x !== s.account);
    const targets = Object.keys(slots.get(m) ?? {}).filter((x) => x !== slot);
    const chosen = () => [...(checks.current?.querySelectorAll<HTMLInputElement>('input[type="checkbox"]') ?? [])].filter((i) => i.checked).map((i) => i.value);
    return (
      <Sec dlg data-dlg="sess">
        <H4>{`Сессии слота ${slot} на ${m} · сейчас ${s.account ?? "—"}`}</H4>
        <b>Сменить аккаунт всему слоту</b>
        <Opts>
          <Sel ref={pickAcc} data-f="swap">
            <option value="">следующего по порядку — выберет Host</option>
            {other.map((x) => (
              <option key={x} value={x}>
                {x}
              </option>
            ))}
          </Sel>
          <Btn pri onClick={() => void sc.swap(m, slot, pickAcc.current?.value ?? "")}>
            Сменить сейчас
          </Btn>
        </Opts>
        <NoteLine sc={sc} k={`swap:${m}:${slot}`} />
        <b>Перевести выбранные в другой слот</b>
        <Opts ref={checks}>
          {s.sessions.map((c) => (
            <OptsLabel key={c}>
              <input type="checkbox" value={c} />
              {c}
            </OptsLabel>
          ))}
          <Sel ref={pickSlot} data-f="target">
            {targets.map((x) => (
              <option key={x} value={x}>
                {x}
              </option>
            ))}
            <option value="">без слота — вход машины</option>
          </Sel>
          <Btn onClick={() => void sc.moveSessions(m, chosen(), pickSlot.current?.value ?? "")}>Перевести</Btn>
        </Opts>
        <NoteLine sc={sc} k={`move:${m}`} />
        <Opts>
          <Btn
            onClick={() => {
              sc.dlg = null;
              sc.draw();
            }}
          >
            Закрыть
          </Btn>
        </Opts>
      </Sec>
    );
  }

  function RmDlg({ sc, m, account }: { sc: Sc; m: string; account: string }) {
    const pick = useRef<HTMLSelectElement>(null);
    const list = slots.get(m) ?? {};
    const inSlots = slotsOf(m, account);
    const others = [...new Set(inSlots.flatMap((sl) => list[sl].order.filter((x) => x !== account)))];
    const sess = inSlots.flatMap((sl) => list[sl].sessions.map((c) => c.split("@")[0]));
    return (
      <Sec dlg data-dlg="rm">
        <H4>{`Удалить ${account} с ${m}`}</H4>
        {inSlots.length ? (
          <div>
            <b>{`${account} сейчас ${inSlots.length > 1 ? "в слотах" : "в слоте"} ${inSlots.join(", ")}`}</b>
            <Note>{`Сначала ${inSlots.length > 1 ? "каждый слот сменит" : "слот сменит"} аккаунт — ${sess.join(", ") || "сессии слота"} продолжат на новом, — потом ${account} уйдёт из порядка слотов и удалится.`}</Note>
          </div>
        ) : null}
        {inSlots.length ? (
          <Row label={`Кого положить в ${inSlots.length > 1 ? "слоты" : `слот ${inSlots[0]}`}`}>
            <Sel ref={pick} data-f="next">
              <option value="">следующего по порядку — выберет Host</option>
              {others.map((x) => (
                <option key={x} value={x}>
                  {x}
                </option>
              ))}
            </Sel>
          </Row>
        ) : null}
        <Note>{`Стирается только папка ${account} на ${m}. Вход машины и другие аккаунты не трогаются.`}</Note>
        <Opts>
          <Btn
            onClick={() => {
              sc.dlg = null;
              sc.draw();
            }}
          >
            Отмена
          </Btn>
          <Btn bad onClick={() => void sc.remove(m, account, pick.current?.value ?? "")}>
            {inSlots.length ? "Сменить и удалить" : "Удалить"}
          </Btn>
        </Opts>
      </Sec>
    );
  }

  // ───── вид «Аккаунты» ─────
  function AccountsView({ sc, pm }: { sc: Sc; pm: string[] }) {
    const dlg = sc.dlg;
    const groups = new Map<string, Array<{ machine: string; name: string; a: Account }>>();
    for (const [m, list] of accs) {
      for (const [name, a] of Object.entries(list)) {
        const key = a.email ?? `name:${name}`;
        groups.set(key, [...(groups.get(key) ?? []), { machine: m, name, a }]);
      }
    }
    const sessions = app.roster()?.sessions ?? [];
    const words = refusals("machine.accounts");
    return (
      <>
        {[...logins].map(([k, l]) => (
          <LoginCard key={k} l={l} />
        ))}
        {dlg?.kind === "new" ? <NewDlg key={dlg.id} sc={sc} d={dlg} /> : null}
        <div className="ac-cards">
          {[...groups].map(([key, list]) => {
            const first = list[0].a;
            const n = sessions.filter((s) => list.some((x) => x.machine === machineOf(s.callsign) && x.name === s.account)).length;
            // окна — запись одной машины, как пришла: первая машина, у которой они есть
            const src = list.find((x) => Object.keys(x.a.limits ?? {}).length);
            const w0 = src ? Object.values(src.a.limits ?? {})[0] : undefined;
            const inN = list.filter((x) => x.a.login === "ok").length;
            return (
              <Sec key={key} data-account={key}>
                <div className="ac-hd">
                  <b>{first.email ?? list[0].name}</b>
                  {first.plan ? <Pill tone="busy">{first.plan}</Pill> : first.email ? null : <Hint>почта — после входа</Hint>}
                  <Hint>{`${n} ${plural(n, "сессия", "сессии", "сессий")}`}</Hint>
                </div>
                {src ? <Windows a={src.a} /> : null}
                {src && w0 ? <Note>{[SRC[w0.src ?? ""] ?? `от ${w0.src}`, src.machine, ago(w0.at)].filter(Boolean).join(" · ")}</Note> : null}
                <div className="ac-sum" data-in={inN}>{`вошёл на ${inN} ${plural(inN, "машине", "машинах", "машинах")}`}</div>
                {list.map((x) => (
                  <MachineRow key={x.machine} sc={sc} m={x.machine} name={x.name} a={x.a} />
                ))}
                <AnyMachine sc={sc} id={key} list={list} pm={pm} />
                {list.map((x) => (
                  <NoteLine key={x.machine} sc={sc} k={`rm:${x.machine}:${x.name}`} />
                ))}
                {list
                  .filter((x) => dlg?.kind === "rm" && dlg.machine === x.machine && dlg.account === x.name)
                  .map((x) => (
                    <RmDlg key={x.machine} sc={sc} m={x.machine} account={x.name} />
                  ))}
                {list.flatMap((x) =>
                  Object.entries(slots.get(x.machine) ?? {})
                    .filter(([n, s]) => s.account === x.name && dlg?.kind === "sess" && dlg.machine === x.machine && dlg.slot === n)
                    .map(([n]) => <SessDlg key={`${x.machine}:${n}`} sc={sc} m={x.machine} slot={n} />),
                )}
              </Sec>
            );
          })}
        </div>
        <Refused list={words} />
        {!groups.size && !words.length ? <Note>{loaded ? "Аккаунтов нет — «+ Новый аккаунт»." : "Загружаю аккаунты машин…"}</Note> : null}
      </>
    );
  }

  // ───── вид «Слоты» ─────
  function SlotCard({ sc, m, name, s }: { sc: Sc; m: string; name: string; s: Slot }) {
    const pick = useRef<HTMLSelectElement>(null);
    const a = accs.get(m) ?? {};
    const free = Object.keys(a).filter((x) => !s.order.includes(x) && a[x].login === "ok");
    const move = (i: number, d: number) => {
      const o = [...s.order];
      const j = i + d;
      if (j < 0 || j >= o.length) return;
      [o[i], o[j]] = [o[j], o[i]];
      void sc.setOrder(m, name, o);
    };
    return (
      <Sec data-slot={`${m}:${name}`}>
        {s.wait ? (
          <Sec tone="wait">
            <b>{`Слот ${name} ждёт сброса · ${hhmm(s.wait * 1000)}`}</b>
          </Sec>
        ) : null}
        <div className="ac-hd">
          <b>{`Слот ${name}`}</b>
          <Hint>{`${s.sessions.length} ${plural(s.sessions.length, "сессия", "сессии", "сессий")}${s.sessions.length ? ": " + s.sessions.map((c) => c.split("@")[0]).join(", ") : ""}`}</Hint>
        </div>
        <div data-current={s.account ?? ""}>
          <Hint>в слоте: </Hint>
          <M>
            <b>{s.account ?? "—"}</b>
          </M>
          {s.account ? <Shared m={m} account={s.account} except={name} /> : null}
        </div>
        <Windows a={s.account ? a[s.account] : undefined} />
        <H4>Запас — по порядку</H4>
        {s.order.map((x, i) => (
          <div key={x} className="ac-ord">
            <b>{x}</b>
            <Hint>{Object.entries(a[x]?.limits ?? {}).map(([k, w]) => `${WIN[k] ?? k} ${Math.round(w.utilization * 100)} %`).join(" · ")}</Hint>
            <Shared m={m} account={x} except={name} />
            <Btn aria-label={`${x} выше`} disabled={i === 0} onClick={() => move(i, -1)}>
              ↑
            </Btn>
            <Btn aria-label={`${x} ниже`} disabled={i === s.order.length - 1} onClick={() => move(i, 1)}>
              ↓
            </Btn>
            {x !== s.account ? (
              <Btn aria-label={`убрать ${x}`} onClick={() => void sc.setOrder(m, name, s.order.filter((y) => y !== x))}>
                ✕
              </Btn>
            ) : null}
          </div>
        ))}
        <Opts>
          <Sel data-f={`add:${name}`} value="" onChange={(e) => e.currentTarget.value && void sc.setOrder(m, name, [...s.order, e.currentTarget.value])}>
            <option value="">+ аккаунт в запас</option>
            {free.map((x) => (
              <option key={x} value={x}>
                {x}
              </option>
            ))}
          </Sel>
          {!s.sessions.length ? (
            <Btn bad onClick={() => void sc.setOrder(m, name, [])}>
              Удалить слот
            </Btn>
          ) : null}
        </Opts>
        <NoteLine sc={sc} k={`set:${m}:${name}`} />
        <Opts>
          <Sel ref={pick} data-f={`now:${name}`}>
            <option value="">следующего по порядку — выберет Host</option>
            {s.order
              .filter((x) => x !== s.account)
              .map((x) => (
                <option key={x} value={x}>
                  {x}
                </option>
              ))}
          </Sel>
          <Btn pri data-act="swap" onClick={() => void sc.swap(m, name, pick.current?.value ?? "")}>
            Сменить сейчас
          </Btn>
        </Opts>
        <NoteLine sc={sc} k={`swap:${m}:${name}`} />
      </Sec>
    );
  }

  /** Новый слот на машине. */
  function NewSlot({ sc, m }: { sc: Sc; m: string }) {
    const nm = useRef<HTMLInputElement>(null);
    const acc = useRef<HTMLSelectElement>(null);
    const a = accs.get(m) ?? {};
    return (
      <Sec>
        <H4>{`+ Новый слот на ${m}`}</H4>
        <Opts>
          <In ref={nm} mono data-f="newslot" placeholder="имя слота" />
          <Sel ref={acc}>
            {Object.keys(a)
              .filter((x) => a[x].login === "ok")
              .map((x) => (
                <option key={x} value={x}>
                  {x}
                </option>
              ))}
          </Sel>
          <Btn onClick={() => nm.current?.value && acc.current?.value && void sc.setOrder(m, nm.current.value, [acc.current.value])}>Создать</Btn>
        </Opts>
      </Sec>
    );
  }

  function SlotsView({ sc, pm }: { sc: Sc; pm: string[] }) {
    const ms = machines("machine.slots");
    const m = sc.slotMachine;
    const list = slots.get(m) ?? {};
    return (
      <>
        {/* кнопками — выбранная и машины открытого проекта, остальные — списком */}
        <Opts data-slot-machines="">
          <PickOne
            all={ms}
            near={pm}
            cur={m}
            on={(v) => {
              sc.slotMachine = v;
              sc.slotChosen = true;
              sc.draw();
            }}
            select={{ "data-f": "slotm", "aria-label": "Другая машина" }}
          />
        </Opts>
        <Refused list={refusals("machine.slots").filter(([k]) => k === `${m} · machine.slots`)} />
        {Object.entries(list).map(([name, s]) => (
          <SlotCard key={`${m}:${name}`} sc={sc} m={m} name={name} s={s} />
        ))}
        {m ? <NewSlot key={m} sc={sc} m={m} /> : null}
        {ms.length ? null : <Note>Нет машин со слотами на связи.</Note>}
      </>
    );
  }

  function Accounts({ params }: ScreenProps) {
    const [, draw] = useReducer((x: number) => x + 1, 0);
    const [sc] = useState(() => makeScreen(params, draw));
    // экран читает данные модуля и roster целиком: аккаунтов немного
    app.use(() => rev);
    app.use(() => app.roster());
    const proj = app.use(() => app.mark("project.current"));
    const pm = app.use(() => (proj ? (app.mark("project.machines", proj) ?? []) : []));
    useEffect(() => {
      opened++;
      void loadAll();
      return () => void opened--;
    }, []);
    if (!sc.slotChosen && params.machine && app.can(params.machine, "machine.slots")) {
      sc.slotMachine = params.machine;
      sc.slotChosen = true;
    }
    const newBtn = machines("machine.login").length ? (
      <Btn
        pri
        onClick={() => {
          sc.dlg = { kind: "new", id: newIds.next++, machine: machines("machine.login")[0], name: "", err: "" };
          sc.draw();
        }}
      >
        + Новый аккаунт
      </Btn>
    ) : null;
    // широкий вид — аккаунты и слоты рядом; узкий — переключатель
    if (app.wide) {
      return (
        <Page>
          <div className="ac-cols">
            <div className="ac-col" data-col="accounts">
              <PageHead title="Аккаунты">{newBtn}</PageHead>
              <AccountsView sc={sc} pm={pm} />
            </div>
            <div className="ac-col" data-col="slots">
              <PageHead title="Слоты" />
              <SlotsView sc={sc} pm={pm} />
            </div>
          </div>
        </Page>
      );
    }
    const setView = (v: string) => {
      sc.view = v;
      sc.draw();
    };
    return (
      <Page>
        <PageHead>
          <Btn aria-pressed={sc.view === "accounts" ? "true" : "false"} onClick={() => setView("accounts")}>
            Аккаунты
          </Btn>
          <Btn aria-pressed={sc.view === "slots" ? "true" : "false"} onClick={() => setView("slots")}>
            Слоты
          </Btn>
          {sc.view === "accounts" ? newBtn : null}
        </PageHead>
        {sc.view === "slots" ? <SlotsView sc={sc} pm={pm} /> : <AccountsView sc={sc} pm={pm} />}
      </Page>
    );
  }

  return {
    on: { roster: onRoster },
    screens: { accounts: { nav: "Аккаунты", group: "Флот", mark: "logins", label: "Аккаунты", view: Accounts, head: () => ({ title: "Аккаунты" }) } },
    marks: {
      logins: () => [...accs.values()].reduce((n, list) => n + Object.values(list).filter((a) => a.login === "pending").length, 0),
    },
    css,
    start(a) {
      app = a;
    },
  };
}
