// pult-open — новая сессия как проводник. Сверху — имя: первое поле и пустое, само не подставляется. Ниже — машины и адрес: одно поле на путь, поиск и создание.
// Папка в адресе и есть место сессии. Список папок только подсказывает, что будет; решает машина при открытии: session.open с mkdir, запрос один, исхода два — сессия или отказ словом.
// Снизу — чипы «Профиль» и модель · усилие · слот, «Точки в R2» (выключены), задача — необязательно. После открытия зовёт вставки места open.after с новой сессией и параметрами,
// с которыми страницу открыли: так «Работа» получает обратно свой проект, а страница о проектах не знает. Своё — короткий список последних мест в настройках человека.
import { useEffect, useRef, useState } from "react";
import type { App, AppModule, ScreenProps, SessionRecord } from "@switchboard/web-core";
import type {} from "@switchboard/web-labels";
import { machineOf } from "@switchboard/protocol";
import { Btn, effortName as effName, EFFORTS, MODELS, personal, profileName as short, type Personal } from "@switchboard/web-ui";
import css from "./open.css";

/** Сколько своих последних мест хранится. */
const RECENT = 5;
const HOME = "~";

type Slots = Record<string, { account: string | null; wait?: number | null; sessions: string[] }>;
type Profiles = Record<string, { model?: string | null; effort?: string | null; about?: string }>;
type Place = { m: string; dir: string };
/** Ответ о родителе адреса: что в нём лежит или слово отказа. */
type Listing = { m: string; parent: string; dirs: string[]; word: string } | null;

/** Состояние формы: один снимок, правка — новым снимком. */
type Form = {
  machine: string;
  addr: string;
  name: string;
  nameErr: string;
  err: string;
  profile: string | null;
  profileSet: boolean;
  model: string;
  effort: string;
  modelSet: boolean;
  slot: string;
  r2: boolean;
  text: string;
  sending: boolean;
  pq: string;
  pop: "" | "prof" | "model";
  pickM: boolean;
  list: Listing;
  slots: Slots | null;
  profiles: Profiles | null;
  refused: Record<string, string>;
};

const EMPTY: Form = { machine: "", addr: HOME, name: "", nameErr: "", err: "", profile: null, profileSet: false, model: "", effort: "", modelSet: false, slot: "", r2: false, text: "", sending: false, pq: "", pop: "", pickM: false, list: null, slots: null, profiles: null, refused: {} };

/** Управляемое поле читает значение из onInput; onChange нужен только React для правила поля со значением. */
const keep = () => {};

/** Адрес → родитель и хвост: набранное после последней косой черты фильтрует список родителя. */
export function splitAddr(addr: string): { parent: string; tail: string } {
  const a = addr.trim().replace(/\\/g, "/");
  const i = a.lastIndexOf("/");
  if (i < 0) return { parent: a || HOME, tail: "" };
  return { parent: i === 0 ? "/" : /^[A-Za-z]:$/.test(a.slice(0, i)) ? a.slice(0, i + 1) : a.slice(0, i), tail: a.slice(i + 1) };
}
/** Адрес без косой черты в конце — папка сессии. */
export const dirOfAddr = (addr: string) => {
  const a = addr.trim().replace(/\\/g, "/");
  return a.length > 1 && !/^[A-Za-z]:\/$/.test(a) ? a.replace(/\/+$/, "") : a;
};
const into = (parent: string, name: string) => `${parent.replace(/\/+$/, "")}/${name}/`;
/** Папки родителя под набранный хвост; скрытые видны, когда имя начато с точки. */
export const matching = (dirs: string[], tail: string) => {
  const t = tail.toLowerCase();
  return dirs.filter((d) => (t.startsWith(".") || !d.startsWith(".")) && d.toLowerCase().startsWith(t));
};
/** Время сброса слота: секунды или миллисекунды эпохи → ЧЧ:ММ. */
const hm = (t: number) => {
  const d = new Date(t < 1e12 ? t * 1000 : t);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};
const dirOf = (s: SessionRecord) => (typeof s.dir === "string" && s.dir ? s.dir : HOME);

/** Новый модуль со своей памятью (в выпуске — один; в тестах — на каждый прогон). */
export function createOpen(): AppModule {
  let app: App;
  let p: Personal;

  const sessions = (): SessionRecord[] => app.roster()?.sessions ?? [];
  const machines = () => (app.roster()?.machines ?? []).map((m) => m.machine).filter((m) => app.can(m, "session.open") === true);
  const can = (m: string, n: string) => app.can(m, n) === true;
  const recents = () => p?.get<Place[]>("recent") ?? [];
  const machineUse = (m: string) => sessions().filter((s) => machineOf(s.callsign) === m).length;

  function Open({ params }: ScreenProps) {
    const [f, setF] = useState<Form>(EMPTY);
    // логика читает последний снимок: ответы приходят позже отрисовки
    const now = useRef(f);
    const s = () => now.current;
    const set = (patch: Partial<Form>) => {
      now.current = { ...now.current, ...patch };
      setF(now.current);
    };

    // экран следит за roster, именами машин и своими местами: выборка перерисует его, когда они изменятся
    useRosterWatch();
    const online = app.use(machines);
    // первый ответ о своих местах нужен, чтобы выбрать место старта
    const known = app.use(() => p.ready() || app.link() !== "open");
    const mLabel = (m: string) => app.mark("label.machine", m) ?? { text: `@${m}`, human: false };

    function setProfile(id: string | null) {
      if (s().modelSet) return set({ profile: id });
      const pr = id ? s().profiles?.[id] : undefined;
      set({ profile: id, model: pr?.model ?? "", effort: pr?.effort ?? "" });
    }
    /** профиль по умолчанию — только от сессии в этой же папке: имя папки ничего не значит */
    function defaultProfile() {
      const { profileSet, profiles, machine, addr } = s();
      if (profileSet) return;
      const have = profiles ?? {};
      const dir = dirOfAddr(addr);
      const used = sessions().find((x) => machineOf(x.callsign) === machine && dirOf(x) === dir && (x.profile as { id?: string } | null)?.id && have[(x.profile as { id: string }).id]);
      setProfile(used ? (used.profile as { id: string }).id : null);
    }

    async function loadMachine() {
      const m = s().machine;
      set({ slots: null, profiles: null, refused: {}, slot: "" });
      const jobs: Array<Promise<void>> = [];
      if (can(m, "machine.slots"))
        jobs.push(
          app.request<{ slots: Slots }>("machine.slots", { machine: m }).then((r) => {
            if (m !== s().machine) return;
            if (!r.ok) return set({ refused: { ...s().refused, "machine.slots": r.error } });
            const slots = r.result.slots ?? {};
            set({ slots, slot: s().slot || (Object.keys(slots)[0] ?? "") });
          }),
        );
      if (can(m, "machine.profiles"))
        jobs.push(
          app.request<{ profiles: Profiles }>("machine.profiles", { machine: m }).then((r) => {
            if (m !== s().machine) return;
            if (!r.ok) return set({ refused: { ...s().refused, "machine.profiles": r.error } });
            set({ profiles: r.result.profiles ?? {} });
            defaultProfile();
          }),
        );
      await Promise.all(jobs);
    }

    /** Список — один запрос на родителя: буквы хвоста новых запросов не дают. */
    async function listParent() {
      const m = s().machine;
      const { parent } = splitAddr(s().addr);
      if (!m || (s().list?.m === m && s().list?.parent === parent)) return;
      set({ list: { m, parent, dirs: [], word: "" } });
      const r = await app.request<{ path: string; dirs: string[] }>("machine.dirs", { machine: m, path: parent });
      if (s().machine !== m || splitAddr(s().addr).parent !== parent) return;
      set({ list: { m, parent, dirs: r.ok ? r.result.dirs : [], word: r.ok ? "" : r.error } });
    }

    function setAddr(addr: string) {
      set({ addr, err: "" });
      void listParent();
      defaultProfile();
    }

    function pick(m: string, dir: string) {
      const same = m === s().machine;
      set({ machine: m, pickM: false, err: "" });
      setAddr(dir);
      if (!same) void loadMachine();
    }

    async function start() {
      const { name } = s();
      set({ nameErr: name ? "" : "нужно имя", err: "" });
      if (!name) return;
      set({ sending: true });
      const { machine, addr, slot, profile, modelSet, model, effort, r2, text } = s();
      const dir = dirOfAddr(addr);
      // создать или нет — решает машина: просьба уходит всегда, агентов это не касается
      const body: Record<string, unknown> = { machine, name, dir, mkdir: true };
      if (slot) body.slot = slot;
      if (profile) body.profile = profile;
      if (modelSet && model) body.model = model;
      if (modelSet && effort) body.effort = effort;
      const r = await app.request<{ callsign: string }>("session.open", body);
      if (!r.ok) {
        const atName = r.error === "name_taken" ? `на ${machine} уже есть ${name}` : r.error === "bad_name" ? "латиница, цифры, точка, - и _" : "";
        set({ sending: false, ...(atName ? { nameErr: atName } : { err: `session.open: ${r.error}` }) });
        return;
      }
      const callsign = r.result.callsign;
      p.edit<Place[]>("recent", (old) => [{ m: machine, dir }, ...(old ?? []).filter((x) => x.m !== machine || x.dir !== dir)].slice(0, RECENT));
      for (const it of app.placed("open.after", params)) app.open(it.screen, { ...params, callsign });
      // пометку «в R2» держит host-points машины новой сессии; manage о ней не знает
      if (r2 && can(machine, "session.r2")) {
        const m = await app.request("session.r2", { callsign, on: true });
        if (!m.ok) app.toast(`${callsign}: «в R2» не включилось — ${m.error}`);
      }
      // задача — необязательно: без неё сессия открыта и ждёт ввода
      if (text.trim()) {
        const t = await app.request("session.prompt", { callsign, text: text.trim(), attachments: [] });
        if (!t.ok) app.toast(`${callsign}: задача не ушла — ${t.error}`);
      }
      set({ sending: false });
      app.open("card", { callsign });
    }

    /** Откуда старт: адрес страницы, иначе последнее своё место, иначе машина с наибольшим числом сессий и домашняя папка. Машина может прийти своим соединением позже первого roster. */
    useEffect(() => {
      if (s().machine) return;
      if (params.machine) {
        if (online.includes(params.machine)) pick(params.machine, params.dir || HOME);
        return;
      }
      if (!known) return;
      const last = recents().find((x) => online.includes(x.m));
      if (last) return pick(last.m, last.dir);
      const m = [...online].sort((a, b) => machineUse(b) - machineUse(a) || a.localeCompare(b))[0];
      if (m) pick(m, HOME);
    }, [online.join(" "), known]);

    const nameRef = useRef<HTMLInputElement>(null);
    useEffect(() => nameRef.current?.focus(), []);

    const { parent, tail } = splitAddr(f.addr);
    const listed = f.list && f.list.m === f.machine && f.list.parent === parent ? f.list : null;
    const shown = listed ? matching(listed.dirs, tail) : [];
    // только подсказка: подпись кнопки и пометка; решает машина
    const isNew = !!listed && (listed.word === "not_found" || (!listed.word && !!tail && !listed.dirs.some((d) => d.toLowerCase() === tail.toLowerCase())));
    const places = [{ m: f.machine, dir: HOME }, ...recents()].filter((x, i, all) => online.includes(x.m) && all.findIndex((y) => y.m === x.m && y.dir === x.dir) === i);

    function machinesPane() {
      return (
        <div className="op-bl" role="listbox" aria-label="Машины">
          {online.length ? (
            [...online].sort((x, y) => machineUse(y) - machineUse(x) || x.localeCompare(y)).map((m) => {
              const l = mLabel(m);
              return (
                <button key={m} role="option" aria-selected={f.machine === m} data-machine={m} onClick={() => pick(m, m === f.machine ? f.addr : HOME)}>
                  <b className={l.human ? "hum" : undefined}>{l.text}</b>
                </button>
              );
            })
          ) : (
            <span className="op-none">машин нет</span>
          )}
        </div>
      );
    }

    function folderPane() {
      return (
        <div className="op-bf">
          {app.wide ? null : (
            <button className="op-bk" data-act="pick-machine" aria-expanded={f.pickM} onClick={() => set({ pickM: !f.pickM })}>
              {f.machine ? mLabel(f.machine).text : "машина"}
            </button>
          )}
          {app.wide || !f.pickM ? null : machinesPane()}
          {places.length > 1 ? (
            <div className="op-rec" aria-label="Последние места">
              {places.map((x) => (
                <button key={`${x.m}|${x.dir}`} data-place={x.dir} data-place-machine={x.m} aria-pressed={x.m === f.machine && x.dir === dirOfAddr(f.addr)} onClick={() => pick(x.m, x.dir)}>
                  {x.m === f.machine ? x.dir : `${mLabel(x.m).text} ${x.dir}`}
                </button>
              ))}
            </div>
          ) : null}
          <input
            data-f="addr"
            value={f.addr}
            autoComplete="off"
            spellCheck={false}
            aria-label="Адрес папки"
            disabled={!f.machine}
            onChange={keep}
            onInput={(e) => setAddr(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Tab" && !e.shiftKey && shown.length && tail) {
                e.preventDefault();
                setAddr(into(parent, shown[0]));
              }
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void start();
            }}
          />
          {isNew ? <div className="op-new" data-mark="new">новая папка, будет создана</div> : null}
          {listed?.word && listed.word !== "not_found" ? <div className="op-new">{listed.word === "no_access" ? "нет доступа к этой папке" : `machine.dirs: ${listed.word}`}</div> : null}
          <div className="op-dl">
            {shown.map((d) => (
              <button key={d} data-dir={d} onClick={() => setAddr(into(parent, d))}>
                <span>{`▸ ${d}`}</span>
              </button>
            ))}
            {!shown.length && listed && !listed.word && !isNew ? <span className="op-none">пусто</span> : null}
          </div>
        </div>
      );
    }

    // ───── окна чипов ─────
    function profPop() {
      const ql = f.pq.trim().toLowerCase();
      const profiles = f.profiles ?? {};
      const ids = Object.keys(profiles);
      return (
        <>
          <div className="lb">{`Профиль · ${mLabel(f.machine).text} · ${ids.length}`}</div>
          <input className="op-flt" data-f="pq" value={f.pq} placeholder="Найти профиль" autoComplete="off" aria-label="Найти профиль" onChange={keep} onInput={(e) => set({ pq: e.currentTarget.value })} />
          {f.refused["machine.profiles"] ? (
            <div className="op-err" role="alert">
              {`machine.profiles: ${f.refused["machine.profiles"]}`}
            </div>
          ) : null}
          {ids
            .filter((id) => !ql || `${id} ${profiles[id].about ?? ""}`.toLowerCase().includes(ql))
            .map((id) => {
              const p = profiles[id];
              return (
                <button
                  key={id}
                  className="op-pr"
                  role="radio"
                  aria-checked={f.profile === id}
                  data-profile={id}
                  onClick={() => {
                    setProfile(id);
                    set({ pop: "" });
                  }}
                >
                  <span className="r1">
                    <b>{short(id)}</b>
                    <span className="sp">{[p.model, p.effort ? effName(p.effort) : null].filter(Boolean).join(" · ")}</span>
                  </span>
                  {p.about ? <span className="r2">{p.about}</span> : null}
                </button>
              );
            })}
          <button
            className="op-pr"
            role="radio"
            aria-checked={f.profile === null}
            data-profile=""
            onClick={() => {
              setProfile(null);
              set({ pop: "" });
            }}
          >
            <span className="r1">
              <b>без профиля</b>
            </span>
          </button>
        </>
      );
    }

    function modelPop() {
      const slots = Object.entries(f.slots ?? {});
      return (
        <>
          <div className="lb">Модель</div>
          <div className="op-opts">
            {MODELS.map((m) => (
              <button key={m} data-model={m} aria-pressed={f.model === m} onClick={() => set({ model: m, modelSet: true })}>
                {m}
              </button>
            ))}
          </div>
          <div className="lb">Усилие</div>
          <div className="op-opts">
            {EFFORTS.map(([k, l]) => (
              <button key={k} data-effort={k} aria-pressed={f.effort === k} onClick={() => set({ effort: k, modelSet: true })}>
                {l}
              </button>
            ))}
          </div>
          {slots.length ? <div className="lb">Слот</div> : null}
          {slots.length ? (
            <div className="op-opts">
              {slots.map(([n, sl]) => (
                <button key={n} data-slot={n} aria-pressed={f.slot === n} onClick={() => set({ slot: n })}>
                  {sl.wait ? `${n} · ждёт сброса ${hm(sl.wait)}` : n}
                </button>
              ))}
            </div>
          ) : null}
          {f.refused["machine.slots"] ? (
            <div className="op-err" role="alert">
              {`machine.slots: ${f.refused["machine.slots"]}`}
            </div>
          ) : null}
          {can(f.machine, "session.r2") || !f.machine ? (
            <div className="op-sw">
              <span>Точки в R2</span>
              <button role="switch" aria-label="Точки в R2" aria-checked={f.r2} data-r2="1" onClick={() => set({ r2: !f.r2 })} />
            </div>
          ) : null}
        </>
      );
    }

    const disabled = f.sending || !f.machine;
    const closePop = () => set({ pop: "" });
    const chip = (kind: "prof" | "model") => () => set({ pop: s().pop === kind ? "" : kind, pq: "" });

    return (
      <div className={"op" + (app.wide ? " wide" : "")}>
        {app.wide ? (
          <div className="op-h">
            <b>Новая сессия</b>
            <button className="op-x" aria-label="Закрыть" onClick={() => app.back()}>
              ✕
            </button>
          </div>
        ) : null}
        <div className="op-body">
          <div className={"op-nm" + (f.nameErr ? " bad" : "")}>
            <label htmlFor="op-name">Имя</label>
            <input
              ref={nameRef}
              id="op-name"
              data-f="name"
              value={f.name}
              required
              aria-required="true"
              autoComplete="off"
              spellCheck={false}
              onChange={keep}
              onInput={(e) => set({ name: e.currentTarget.value.trim(), nameErr: "" })}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void start();
              }}
            />
          </div>
          {f.nameErr ? (
            <span className="op-err" role="alert" data-err="name">
              {f.nameErr}
            </span>
          ) : null}
          {app.wide ? (
            <div className="op-brw">
              <div className="op-bm">{machinesPane()}</div>
              {folderPane()}
            </div>
          ) : (
            <div className="op-brw one">{folderPane()}</div>
          )}
        </div>
        <div className="op-cmp">
          {f.pop && !app.wide ? <div className="op-shade" onClick={closePop} /> : null}
          {f.pop ? (
            <div className="op-pop" role="dialog" aria-label="Выбор">
              {f.pop === "prof" ? profPop() : modelPop()}
              {app.wide ? null : (
                <Btn pri className="op-done" onClick={closePop}>
                  Готово
                </Btn>
              )}
            </div>
          ) : null}
          <div className="op-ctx">
            <button className="op-cx" data-pop="prof" aria-expanded={f.pop === "prof"} disabled={!f.machine} onClick={chip("prof")}>
              <span className="k">Профиль</span>
              <b>{f.profile ? short(f.profile) : "без профиля"}</b>
            </button>
            <button className="op-cx" data-pop="model" aria-expanded={f.pop === "model"} onClick={chip("model")}>
              <b>{f.model || "модель"}</b>
              <span className="k">{[f.effort ? effName(f.effort) : null, f.slot, f.r2 ? "R2" : null].filter(Boolean).join(" · ")}</span>
            </button>
          </div>
          <textarea
            data-f="text"
            rows={3}
            aria-label="Задача"
            placeholder="Что сделать?"
            defaultValue=""
            onInput={(e) => set({ text: e.currentTarget.value })}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                if (!disabled) void start();
              }
            }}
          />
          {f.err ? (
            <span className="op-err" role="alert">
              {f.err}
            </span>
          ) : null}
          <div className="op-foot">
            <Btn pri data-act="open" disabled={disabled} onClick={() => void start()}>
              {isNew ? "Создать и открыть" : f.text.trim() ? "Начать" : "Открыть"}
            </Btn>
          </div>
        </div>
      </div>
    );
  }

  /** Перерисовка экрана при новом roster, новых именах машин и своих местах: выборка отдаёт то, что экран читает. */
  function useRosterWatch() {
    app.use(() => ({ sessions: sessions(), recent: recents(), names: (app.roster()?.machines ?? []).map((m) => app.mark("label.machine", m.machine)) }));
  }

  return {
    on: {
      link(state) {
        if (state === "open") void p.read();
      },
    },
    screens: { open: { label: "Новая сессия", view: Open, head: () => ({ title: "Новая сессия" }) } },
    css,
    start(a) {
      app = a;
      p ??= personal(app, "pult-open", () => app.changed());
    },
    async stop() {
      await p?.settled();
    },
  };
}
