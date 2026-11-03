// Карточка сессии в широком виде (пульт), по прототипу «Пульт и телефон»: шапка — одна строка
// (лампа с подсказкой состояния, позывной, «модель · усилие ▾», «аккаунт · % ▾», вкладки, «Прервать»/«Запустить», «⋯»),
// плашка — только у не запустившейся, сведения сбоку — по желанию. Вкладки: «Разговор» · вкладки места card.tab
// · «Настройки» · «Журнал». Поле — у своего владельца: модель, усилие, быстрый режим, заголовок — session.update;
// слот — session.slot; профиль — session.profile; итог изменения — из следующего roster. Нет имени в contract — нет кнопки.
import { Fragment, useEffect, useRef, useState, type RefObject } from "react";
import type { App, Head, SessionRecord } from "@switchboard/web-core";
import type {} from "@switchboard/web-labels";
import { Dot, effortName as effName, EFFORTS, hhmm, MODELS, myAddress, profileName } from "@switchboard/web-ui";
import { machineOf, userOf } from "@switchboard/protocol";

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
const LIVE = new Set(["idle", "busy", "waiting"]);
/** Окна лимитов аккаунта → подпись. */
const WINDOWS: Record<string, string> = { five_hour: "5 часов", seven_day: "неделя", seven_day_opus: "неделя Opus" };
/** С этой доли окна 5 часов кнопка аккаунта жёлтая. */
const LIMIT_HINT = 0.7;
/** Запросы, от которых зависят кнопки карточки. */
const NAMES = ["session.stop", "session.start", "session.update", "session.spec", "session.call", "session.remove", "session.slot", "session.profile", "machine.slots", "machine.profiles", "machine.accounts", "machine.journal"] as const;
type Name = (typeof NAMES)[number];

type Win = { utilization: number; resetsAt?: number };
type Acc = { email?: string; plan?: string; limits?: Record<string, Win> };
type SlotInfo = { account: string | null; order?: string[] };
type Mcp = { name: string; status?: string };
type Rec = { t: string; part?: string; who?: string; kind?: string; ev?: string; word?: string; why?: string; callsign?: string };
type Model = { value: string; displayName?: string };
type Pop = "" | "model" | "acc" | "menu";
type Note = { text: string; tone: string };

const msg = (r: { ok: boolean; error?: string }) => (r.ok ? "" : String(r.error));
/** Время сброса: секунды или миллисекунды эпохи → ЧЧ:ММ. */
const at = (t: number) => hhmm(t < 1e12 ? t * 1000 : t);
const slotOf = (s?: SessionRecord) => s?.slot as { name?: string; wait?: number | null } | null | undefined;
const profileOf = (s?: SessionRecord) => (s?.profile as { id?: string } | null | undefined)?.id;
const failedText = (s: SessionRecord) => (s.failed ? Object.entries(s.failed as Record<string, string>).map(([k, v]) => `${k}: ${v}`).join("; ") : "");

/** Полночь сегодня по местному времени — since журнала машины. */
function midnight(daysBack = 0): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - daysBack);
  return d.toISOString();
}

/** Что показывать в шапке — выбор устройства; переключатели — экран card.view в панели вида «Работы». */
export const HEAD0 = { haddr: false, howner: true, hprof: true, hmodel: true };
export type HeadView = typeof HEAD0;

export const sessionName = (app: App, callsign: string) => app.mark("label.session", callsign) ?? { text: callsign, human: false };
export const machineName = (app: App, machine: string) => app.mark("label.machine", machine) ?? { text: `@${machine}`, human: false };

/** Хук: что умеет машина — по contract из roster; кнопка перерисуется, когда он изменился. */
export function useCan(app: App, machine: string): (name: Name) => boolean {
  const on = app.use(() => NAMES.filter((n) => app.can(machine, n) === true));
  return (name) => on.includes(name);
}

/** Хук: запись сессии из roster. */
export function useSession(app: App, callsign: string): SessionRecord | undefined {
  return app.use(() => app.roster()?.sessions.find((s) => s.callsign === callsign));
}

/** Окно «Имена» web-labels поверх карточки. */
export function Names({ app, callsign, close }: { app: App; callsign: string; close(): void }) {
  return (
    <div>
      <app.Slot screen="labels" params={{ callsign }} close={close} />
    </div>
  );
}

/** Состояние карточки, общее для всех карточек модуля: сведения сбоку и шапка — выбор устройства. */
export type WideOpts = { head: () => HeadView; info: () => boolean; setInfo: (v: boolean) => void };

/** Шапка экрана широкой карточки. */
export function wideHead(app: App, callsign: string): Head {
  const s = app.roster()?.sessions.find((x) => x.callsign === callsign);
  const n = sessionName(app, callsign);
  if (!s) return { title: n.text, mono: !n.human };
  return { title: n.text, mono: !n.human, sub: [s.model, effName(s.effort)].filter(Boolean).join(" · ") };
}

/** Карточка сессии в широком виде. */
export function Wide({ app, params, o }: { app: App; params: Record<string, string>; o: WideOpts }) {
  const callsign = params.callsign ?? "";
  const machine = machineOf(callsign) ?? "";
  const s = useSession(app, callsign);
  const can = useCan(app, machine);
  const view = app.use(o.head);
  const info = app.use(o.info);
  const name = app.use(() => sessionName(app, callsign));
  const host = app.use(() => machineName(app, machine));
  const myAddr = app.use(() => myAddress(app));
  const placedTabs = app.use(() => app.placed("card.tab", { callsign }));
  const menuItems = app.use(() => app.placed("card.menu", { callsign }));
  const kids = app.use(() => (app.roster()?.sessions ?? []).filter((x) => x.parent === callsign).map((x) => x.callsign));
  const live = LIVE.has(String(s?.state));

  /** вкладка: разговор и вставка места — экран в месте, остальное — настройки или журнал */
  const resolve = (k: string) => {
    if (k === "chat" || app.placed("card.tab", { callsign }).some((t) => t.screen === k)) return k;
    if (k === "log" && app.can(machine, "machine.journal") === true) return k;
    return "set";
  };
  const [tab, setTab] = useState(() => resolve(params.tab ?? "chat"));
  const select = (k: string) => {
    if (k !== tab) setTab(resolve(k));
  };
  const [headNote, setHeadNote] = useState("");
  /** открытое окно шапки: модель, аккаунт или меню ⋯ */
  const [pop, setPop] = useState<Pop>("");
  const [accounts, setAccounts] = useState<Record<string, Acc> | null>(null);
  const [slots, setSlots] = useState<Record<string, SlotInfo> | null>(null);
  const [models, setModels] = useState<Model[] | null>(null);
  const [mcp, setMcp] = useState<Mcp[] | null>(null);
  const [names, setNames] = useState(false);

  // окна шапки закрываются кликом мимо и Esc; клик внутри шапки помечает её обработчик — он срабатывает раньше слушателя документа
  const inHead = useRef<Event | null>(null);
  useEffect(() => {
    const outside = (e: Event) => {
      if (e !== inHead.current) setPop("");
    };
    const esc = (e: Event) => {
      if ((e as KeyboardEvent).key === "Escape") setPop("");
    };
    document.addEventListener("click", outside);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("click", outside);
      document.removeEventListener("keydown", esc);
    };
  }, []);

  // ───── запросы шапки ─────
  async function interrupt() {
    const r = await app.request("session.call", { callsign, method: "interrupt", args: [] });
    setHeadNote(r.ok ? "" : `Прервать: ${msg(r)}`);
  }

  async function start() {
    const r = await app.request("session.start", { callsign });
    if (!r.ok) app.toast(`${callsign}: «Запустить» — ${msg(r)}`);
  }

  async function update(body: Record<string, unknown>, what: string) {
    setPop("");
    const r = await app.request("session.update", { callsign, ...body });
    if (!r.ok) app.toast(`${callsign}: ${what} — ${msg(r)}`);
  }

  /** аккаунты и слоты машины: подпись кнопки аккаунта и её окно */
  async function loadAccounts() {
    const jobs: Array<Promise<void>> = [];
    if (app.can(machine, "machine.accounts") === true)
      jobs.push(
        app.request<{ accounts: Record<string, Acc> }>("machine.accounts", { machine }).then((r) => {
          if (r.ok) setAccounts(r.result.accounts ?? {});
        }),
      );
    if (app.can(machine, "machine.slots") === true)
      jobs.push(
        app.request<{ slots: Record<string, SlotInfo> }>("machine.slots", { machine }).then((r) => {
          if (r.ok) setSlots(r.result.slots ?? {});
        }),
      );
    await Promise.all(jobs);
  }

  async function loadModels() {
    if (models || !live || !can("session.call")) return;
    const r = await app.request<Model[]>("session.call", { callsign, method: "supportedModels", args: [] });
    if (r.ok && Array.isArray(r.result)) setModels(r.result);
  }

  function toggle(p: "model" | "acc" | "menu") {
    const next = pop === p ? "" : p;
    setPop(next);
    if (next === "model") void loadModels();
    if (next === "acc") void loadAccounts();
  }

  // ───── сведения сбоку ─────
  async function loadMcp() {
    if (!live || app.can(machine, "session.call") !== true) return;
    const r = await app.request<Mcp[]>("session.call", { callsign, method: "mcpServerStatus", args: [] });
    if (r.ok && Array.isArray(r.result)) setMcp(r.result);
  }

  async function mcpToggle(m: Mcp) {
    const r = await app.request("session.call", { callsign, method: "toggleMcpServer", args: [m.name, m.status === "disabled"] });
    if (!r.ok) return app.toast(`toggleMcpServer: ${msg(r)}`);
    setMcp(null);
    await loadMcp();
  }

  useEffect(() => void loadAccounts(), []);
  useEffect(() => {
    if (info && !mcp) void loadMcp();
  }, [info, live]);

  // ───── части шапки ─────
  const nameEl = (
    <button className="cw-nm" data-act="names" aria-label="Имена сессии и машины" onClick={() => setNames(true)}>
      <span className="cw-nm1">
        <b className={"cw-cs" + (name.human ? " hum" : "")}>{name.text}</b>
        <span className={"cw-at" + (host.human ? " hum" : "")}>{host.text}</span>
        <span className="cw-ed" aria-hidden="true">
          ✎
        </span>
      </span>
      {view.haddr && (name.human || host.human) ? <span className="cw-real">{callsign}</span> : null}
    </button>
  );

  const tabList: Array<[string, string]> = [["chat", "Разговор"], ...placedTabs.map((t): [string, string] => [t.screen, t.label]), ["set", "Настройки"], ...(can("machine.journal") ? ([["log", "Журнал"]] as Array<[string, string]>) : [])];
  const tabsEl = (
    <div className="cw-tabs" role="tablist">
      {tabList.map(([k, label]) => (
        <button key={k} role="tab" aria-selected={tab === k ? "true" : "false"} data-tab={k} onClick={() => select(k)}>
          {label}
        </button>
      ))}
    </div>
  );

  function headContent(x: SessionRecord) {
    const [, dot] = LABEL[String(x.state)] ?? ["", ""];
    const [label] = LABEL[String(x.state)] ?? [String(x.state)];
    const why = failedText(x);
    const t = x.state === "failed" && why ? `${label}: ${why}` : label;
    const sl = slotOf(x);
    const w5 = accounts?.[String(x.account ?? "")]?.limits?.five_hour;
    const accText = sl?.wait ? `ждёт сброса ${at(sl.wait)}` : w5 ? `${Math.round(w5.utilization * 100)} %` : "";
    const accCls = sl?.wait ? "you" : w5 && w5.utilization >= LIMIT_HINT ? "lim" : "";
    const stopped = x.state === "stopped" || x.state === "failed";
    const owner = typeof x.by === "string" ? userOf(x.by) : null;
    const prof = profileOf(x) ? profileName(profileOf(x)!) : undefined;
    // слева кто, справа вкладки и действия: не помещаются в строку — вкладки уходят второй строкой
    return (
      <>
        <div className="cw-hl">
          <Dot kind={dot} className="cw-lamp" tabIndex={0} role="img" title={t} aria-label={t} data-tip={t} />
          {nameEl}
          <span className="cw-meta">
            {view.howner && owner && owner !== myAddr ? <span className="cw-pill">{owner.slice(1)}</span> : null}
            {view.hprof && prof ? <span className="cw-pill">{prof}</span> : null}
          </span>
          <span className="cw-hpw">
            {view.hmodel && (x.model || can("session.update")) ? (
              <button className="cw-hb" data-pop="model" aria-expanded={pop === "model" ? "true" : "false"} disabled={!can("session.update")} onClick={() => toggle("model")}>
                {`${[x.model, x.effort ? effName(x.effort) : null].filter(Boolean).join(" · ") || "модель"} ▾`}
              </button>
            ) : null}
            {x.account ? (
              <button className={`cw-hb ${accCls}`} data-pop="acc" aria-expanded={pop === "acc" ? "true" : "false"} onClick={() => toggle("acc")}>
                {`${[x.account, accText].filter(Boolean).join(" · ")} ▾`}
              </button>
            ) : null}
            {pop === "model" ? <ModelPop s={x} models={models} update={update} /> : pop === "acc" ? <AccPop s={x} machine={machine} accounts={accounts} slots={slots} canSlot={can("session.slot")} changeSlot={() => (setPop(""), select("set"))} /> : null}
          </span>
        </div>
        <div className="cw-hr">
          {tabsEl}
          {x.state === "busy" && can("session.call") ? (
            <button className="cw-b bad" onClick={() => void interrupt()}>
              ■ Прервать
            </button>
          ) : null}
          {stopped && can("session.start") ? (
            <button className="cw-b pri" onClick={() => void start()}>
              Запустить
            </button>
          ) : null}
          {headNote ? <span className="cw-why">{headNote}</span> : null}
          {/* пункты места card.menu: закрепление (web-board) */}
          {menuItems.map((m) => (
            <button key={m.screen} className="cw-b" data-screen={m.screen} onClick={() => app.open(m.screen, { from: callsign })}>
              {m.label}
            </button>
          ))}
          <span className="cw-mw">
            <button className="cw-b ghost cw-more" data-pop="menu" aria-haspopup="menu" aria-expanded={pop === "menu" ? "true" : "false"} aria-label="Действия сессии" onClick={() => toggle("menu")}>
              ⋯
            </button>
            {pop === "menu" ? <MenuPop s={x} machine={machine} callsign={callsign} info={info} toggleInfo={() => (setPop(""), o.setInfo(!o.info()))} /> : null}
          </span>
        </div>
      </>
    );
  }

  const failed = s?.state === "failed";
  const remote = (s?.remote as { url?: string } | undefined)?.url;
  const from = typeof s?.by === "string" ? s.by : "";
  return (
    <>
      <div className="cw">
        <div className="cw-h" onClick={(e) => (inHead.current = e.nativeEvent)}>
          {s ? (
            headContent(s)
          ) : (
            <>
              <div className="cw-hl">
                <Dot kind="stop" className="cw-lamp" role="img" title="не на связи" aria-label="не на связи" />
                {nameEl}
                <span className="cw-note">не на связи</span>
              </div>
              <div className="cw-hr">{tabsEl}</div>
            </>
          )}
        </div>
        {/* плашка — только у не запустившейся: причина и журнал */}
        <div className="cw-pl" role="status" hidden={!failed}>
          {failed ? (
            <>
              <b>{`Не запустилась${failedText(s!) ? ": " + failedText(s!) : ""}`}</b>
              {can("machine.journal") ? (
                <button className="cw-b" onClick={() => select("log")}>
                  Почему
                </button>
              ) : null}
            </>
          ) : null}
        </div>
        <div className={"cw-body" + (info ? " info" : "")}>
          <div className="cw-place">
            {tab === "log" ? (
              <LogTab app={app} machine={machine} callsign={callsign} />
            ) : tab === "set" ? (
              <SetTab app={app} machine={machine} callsign={callsign} s={s} can={can} live={live} slots={slots} setSlots={setSlots} update={update} />
            ) : (
              <app.Slot key={tab} screen={tab} params={{ callsign }} />
            )}
          </div>
          {info ? (
            <aside className="cw-info" aria-label="Сведения">
              {s ? (
                <>
                  <div>
                    <h4>Сведения</h4>
                    <dl className="cw-kv">
                      {from ? <Kv k="задачу дал" v={from} /> : null}
                      {typeof s.dir === "string" ? <Kv k="папка" v={s.dir} /> : null}
                      <Kv k="профиль" v={profileOf(s) ? profileName(profileOf(s)!) : "без профиля"} />
                    </dl>
                  </div>
                  {typeof s.parent === "string" || kids.length ? (
                    <div>
                      <h4>Дерево</h4>
                      <dl className="cw-kv">
                        {typeof s.parent === "string" ? <Kv k="открыла" v={s.parent} /> : null}
                        {kids.length ? (
                          <>
                            <dt>ведёт</dt>
                            <dd>
                              {kids.map((k) => (
                                <button key={k} className="cw-b ghost kid" onClick={() => app.open("card", { callsign: k })}>
                                  {k}
                                </button>
                              ))}
                            </dd>
                          </>
                        ) : null}
                      </dl>
                    </div>
                  ) : null}
                  {mcp?.length ? (
                    <div>
                      <h4>Серверы MCP</h4>
                      {mcp.map((m) => (
                        <div key={m.name} className="cw-sw">
                          <span>{m.name}</span>
                          <button className="cw-b" data-mcp={m.name} onClick={() => void mcpToggle(m)}>
                            {m.status === "disabled" ? "вкл" : "выкл"}
                          </button>
                        </div>
                      ))}
                    </div>
                  ) : null}
                  {remote ? (
                    <a className="cw-mi flat" href={remote} target="_blank" rel="noopener">
                      Открыть в claude.ai ↗
                    </a>
                  ) : null}
                </>
              ) : null}
            </aside>
          ) : null}
        </div>
      </div>
      {names ? <Names app={app} callsign={callsign} close={() => setNames(false)} /> : null}
    </>
  );
}

/** Строка «подпись — значение» списка сведений. */
function Kv({ k, v }: { k: string; v: string }) {
  return (
    <>
      <dt>{k}</dt>
      <dd>{v}</dd>
    </>
  );
}

function ModelPop({ s, models, update }: { s: SessionRecord; models: Model[] | null; update(body: Record<string, unknown>, what: string): Promise<void> }) {
  const list: Model[] = models ?? MODELS.map((m) => ({ value: m }));
  return (
    <div className="cw-pop l" role="dialog" aria-label="Модель и усилие">
      <span className="lb">Модель</span>
      {list.map((m) => (
        <button key={m.value} className="cw-mi" role="menuitemradio" aria-checked={m.value === s.model ? "true" : "false"} data-model={m.value} onClick={() => void update({ model: m.value }, "модель")}>
          {`${m.value === s.model ? "✓ " : ""}${m.displayName ?? m.value}`}
        </button>
      ))}
      <span className="lb">Усилие</span>
      <div className="cw-opts">
        {EFFORTS.map(([k, l]) => (
          <button key={k} className="cw-b" aria-pressed={s.effort === k ? "true" : "false"} data-effort={k} onClick={() => void update({ effort: k }, "усилие")}>
            {l}
          </button>
        ))}
      </div>
    </div>
  );
}

function AccPop({ s, machine, accounts, slots, canSlot, changeSlot }: { s: SessionRecord; machine: string; accounts: Record<string, Acc> | null; slots: Record<string, SlotInfo> | null; canSlot: boolean; changeSlot(): void }) {
  const name = String(s.account ?? "");
  const a = accounts?.[name];
  const sl = slotOf(s);
  const queue = sl?.name ? (slots?.[sl.name]?.order ?? []) : [];
  return (
    <div className="cw-pop l w" role="dialog" aria-label="Аккаунт и лимиты">
      <dl className="cw-kv">
        <Kv k="аккаунт" v={[a?.email ?? name, a?.plan].filter(Boolean).join(" · ")} />
        {sl?.name ? <Kv k="слот" v={`${sl.name} @${machine}`} /> : null}
      </dl>
      {Object.entries(a?.limits ?? {}).map(([k, w]) => {
        const p = Math.round(w.utilization * 100);
        return (
          <div key={k} className="cw-win" data-win={k}>
            <span>{WINDOWS[k] ?? k}</span>
            <div className={`cw-meter${p >= 95 ? " full" : p >= 70 ? " hot" : ""}`}>
              <i style={{ width: `${Math.min(p, 100)}%` }} />
            </div>
            <span className="v">{`${p} %${w.resetsAt ? " · до " + at(w.resetsAt) : ""}`}</span>
          </div>
        );
      })}
      {queue.length ? <div className="cw-note queue">{`очередь слота: ${queue.join(" → ")}`}</div> : null}
      {canSlot ? (
        <div className="cw-opts">
          <button className="cw-b" onClick={changeSlot}>
            Сменить слот
          </button>
        </div>
      ) : null}
    </div>
  );
}

function MenuPop({ s, machine, callsign, info, toggleInfo }: { s: SessionRecord; machine: string; callsign: string; info: boolean; toggleInfo(): void }) {
  const remote = (s.remote as { url?: string } | undefined)?.url;
  const inc = s.incident as { type?: string; key?: string } | null | undefined;
  return (
    <div className="cw-pop r" role="menu" aria-label={`Сессия ${callsign}`}>
      <dl className="cw-kv">
        <Kv k="профиль" v={profileOf(s) ? profileName(profileOf(s)!) : "без профиля"} />
        {typeof s.dir === "string" ? <Kv k="папка" v={s.dir} /> : null}
        <Kv k="машина" v={`@${machine}`} />
        {inc?.type ? <Kv k="инцидент" v={[inc.type, inc.key].filter(Boolean).join(" · ")} /> : null}
      </dl>
      <hr />
      <button className="cw-mi" role="menuitemcheckbox" aria-checked={info ? "true" : "false"} data-act="info" onClick={toggleInfo}>
        {`${info ? "✓ " : ""}Сведения сбоку`}
      </button>
      {remote ? (
        <a className="cw-mi" role="menuitem" href={remote} target="_blank" rel="noopener">
          Открыть в claude.ai ↗
        </a>
      ) : null}
    </div>
  );
}

// ───── настройки ─────
function SetTab({ app, machine, callsign, s, can, live, slots, setSlots, update }: { app: App; machine: string; callsign: string; s: SessionRecord | undefined; can(name: Name): boolean; live: boolean; slots: Record<string, SlotInfo> | null; setSlots(v: Record<string, SlotInfo>): void; update(body: Record<string, unknown>, what: string): Promise<void> }) {
  const [notes, setNotes] = useState<Record<string, Note>>({});
  const [profiles, setProfiles] = useState<string[] | null>(null);
  const [title, setTitleNow] = useState<string | null>(null);
  const [titleEdit, setTitleEdit] = useState<string | undefined>();
  const [removing, setRemoving] = useState(false);
  const titleEl = useRef<HTMLInputElement>(null);

  const note = (k: string, text: string, tone = "") => setNotes((old) => ({ ...old, [k]: { text, tone } }));
  const noteEl = (k: string) =>
    notes[k]?.text ? (
      <div className={`cw-note ${notes[k].tone}`} role="status">
        {notes[k].text}
      </div>
    ) : null;

  useEffect(() => {
    if (app.can(machine, "session.spec") === true)
      void app.request<{ title?: string | null }>("session.spec", { callsign }).then((r) => {
        if (r.ok) setTitleNow(r.result.title ?? "");
      });
    if (app.can(machine, "machine.profiles") === true)
      void app.request<{ profiles: Record<string, unknown> }>("machine.profiles", { machine }).then((r) => {
        if (r.ok) setProfiles(Object.keys(r.result.profiles ?? {}));
      });
    if (!slots && app.can(machine, "machine.slots") === true)
      void app.request<{ slots: Record<string, SlotInfo> }>("machine.slots", { machine }).then((r) => {
        if (r.ok) setSlots(r.result.slots ?? {});
      });
  }, []);

  async function move(name: "session.slot" | "session.profile", value: string | null) {
    const key = name === "session.slot" ? "slot" : "profile";
    note(key, "…");
    const r = await app.request<{ restart?: boolean }>(name, { callsign, [key]: value });
    if (!r.ok) return note(key, `Не вышло: ${msg(r)}`, "bad");
    note(key, r.result?.restart ? "после хода" : "", "ok");
  }

  // заголовок уходит по событию change поля: подтверждение ввода, а не каждая буква
  const saveTitle = useRef<(el: HTMLInputElement) => Promise<void>>(async () => {});
  saveTitle.current = async (el) => {
    const v = el.value;
    if (v === (title ?? "")) return;
    const r = await app.request("session.update", { callsign, title: v });
    if (!r.ok) return note("title", `Не вышло: ${msg(r)}`, "bad");
    setTitleNow(v);
    setTitleEdit(undefined);
    note("title", "");
  };
  useNativeChange(titleEl, (el) => void saveTitle.current(el));

  async function act(name: "session.stop" | "session.start" | "session.remove") {
    note("ctl", "…");
    const r = await app.request(name, { callsign });
    if (!r.ok) return note("ctl", `${name}: ${msg(r)}`, "bad");
    if (name === "session.remove") return app.back();
    note("ctl", "");
  }

  const profNow = profileOf(s) ?? "";
  const slotNow = slotOf(s)?.name ?? "";
  const fast = !!(s?.fast as boolean | undefined);
  const stopped = s?.state === "stopped" || s?.state === "failed";
  return (
    <div className="cw-set">
      {can("session.profile") ? (
        <div className="cw-fs" data-sec="profile">
          <span className="lb">Профиль</span>
          <div className="cw-opts flat">
            {[...(profiles ?? (profNow ? [profNow] : [])), ""].map((p) => (
              <button key={p} className="cw-b" aria-pressed={profNow === p ? "true" : "false"} data-profile={p} onClick={() => (p === profNow ? null : void move("session.profile", p || null))}>
                {p ? profileName(p) : "без профиля"}
              </button>
            ))}
          </div>
          {noteEl("profile")}
        </div>
      ) : null}
      {can("session.update") ? (
        <label className="cw-sw" data-sec="fast">
          <button className="cw-b" role="switch" aria-checked={fast ? "true" : "false"} aria-pressed={fast ? "true" : "false"} onClick={() => void update({ fast: !fast }, "быстрый режим")}>
            {fast ? "вкл" : "выкл"}
          </button>
          <span>Быстрый режим</span>
        </label>
      ) : null}
      {can("session.update") ? (
        <div className="cw-fs" data-sec="title">
          <span className="lb">Заголовок</span>
          <input ref={titleEl} className="cw-in" data-f="title" placeholder="Заголовок в claude.ai" value={titleEdit ?? title ?? ""} onChange={() => {}} onInput={(e) => setTitleEdit(e.currentTarget.value)} />
          {noteEl("title")}
        </div>
      ) : null}
      {can("session.slot") ? (
        <div className="cw-fs" data-sec="slot">
          <span className="lb">Слот</span>
          <div className="cw-opts flat">
            {[...Object.keys(slots ?? (slotNow ? { [slotNow]: 1 } : {})), ""].map((v) => (
              <button key={v} className="cw-b" aria-pressed={slotNow === v ? "true" : "false"} data-slot={v} onClick={() => (v === slotNow ? null : void move("session.slot", v || null))}>
                {v || "без слота"}
              </button>
            ))}
          </div>
          {noteEl("slot")}
        </div>
      ) : null}
      <div className="cw-fs" data-sec="ctl">
        <span className="lb">Сессия</span>
        <div className="cw-opts flat">
          {s && live && can("session.stop") ? (
            <button className="cw-b" onClick={() => void act("session.stop")}>
              Остановить
            </button>
          ) : null}
          {s && stopped && can("session.start") ? (
            <button className="cw-b pri" onClick={() => void act("session.start")}>
              Запустить
            </button>
          ) : null}
          {s && can("session.remove") && !removing ? (
            <button className="cw-b bad" onClick={() => setRemoving(true)}>
              Убрать…
            </button>
          ) : null}
        </div>
        {removing ? (
          <div className="cw-confirm">
            <span>{`${callsign} остановится и уйдёт из списка. Точки в R2 останутся.`}</span>
            <div className="cw-opts flat">
              <button className="cw-b bad" onClick={() => void act("session.remove")}>
                Убрать
              </button>
              <button className="cw-b" onClick={() => setRemoving(false)}>
                Отмена
              </button>
            </div>
          </div>
        ) : null}
        {noteEl("ctl")}
      </div>
    </div>
  );
}

/** Хук: слушатель настоящего события change поля (onChange в React срабатывает на каждую букву). */
function useNativeChange(ref: RefObject<HTMLInputElement | null>, fn: (el: HTMLInputElement) => void) {
  const latest = useRef(fn);
  latest.current = fn;
  const el = ref.current;
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const on = () => latest.current(node);
    node.addEventListener("change", on);
    return () => node.removeEventListener("change", on);
  }, [el, ref]);
}

// ───── журнал машины ─────
function LogTab({ app, machine, callsign }: { app: App; machine: string; callsign: string }) {
  const [kind, setKind] = useState("");
  const [days, setDays] = useState(0);
  const [recs, setRecs] = useState<Rec[]>([]);
  const [more, setMore] = useState(false);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);

  async function load(since: string, append: boolean, k = kind) {
    setLoading(true);
    const r = await app.request<{ records: Rec[]; more: boolean }>("machine.journal", { machine, session: callsign, since, limit: 50, ...(k ? { kind: [k] } : {}) });
    setLoading(false);
    if (r.ok) {
      setRecs((old) => (append ? [...old, ...r.result.records] : r.result.records));
      setMore(!!r.result.more);
      setErr("");
    } else setErr(msg(r));
  }

  useEffect(() => void load(midnight(days), false), []);

  return (
    <div className="cw-log">
      <div className="cw-opts flat">
        {["", "stop", "refuse", "note"].map((k) => (
          <button
            key={k}
            className="cw-b"
            aria-pressed={kind === k ? "true" : "false"}
            onClick={() => {
              setKind(k);
              void load(midnight(days), false, k);
            }}
          >
            {k || "все"}
          </button>
        ))}
        <span className="cw-note">{`${machine} · ${days ? `с ${days} дн. назад` : "сегодня"}`}</span>
      </div>
      {err ? (
        <div className="cw-note bad" role="alert">
          {`machine.journal: ${err}`}
        </div>
      ) : null}
      {recs.map((x, i) => {
        const d = new Date(x.t);
        return (
          <Fragment key={i}>
            <div className="cw-lr">
              <span>{Number.isNaN(d.getTime()) ? x.t : `${hhmm(d)}:${String(d.getSeconds()).padStart(2, "0")}`}</span>
              <span className={`k ${x.kind ?? ""}`}>{x.kind ?? ""}</span>
              <span className="w">{[x.part, x.who].filter(Boolean).join(" · ")}</span>
              <span className="x">{[x.ev, x.word, x.why].filter(Boolean).join(" · ")}</span>
            </div>
          </Fragment>
        );
      })}
      {!recs.length && !loading && !err ? <div className="cw-note">Записей нет.</div> : null}
      {more ? (
        <button className="cw-b" onClick={() => void load(recs.at(-1)!.t, true)}>
          дальше →
        </button>
      ) : null}
      <button
        className="cw-b"
        onClick={() => {
          setDays(days + 1);
          void load(midnight(days + 1), false);
        }}
      >
        Раньше
      </button>
    </div>
  );
}
