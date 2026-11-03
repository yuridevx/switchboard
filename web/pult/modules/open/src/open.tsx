// pult-open — новая сессия: пустой разговор. Сверху — где: «Недавние» (места сессий на машинах на связи) или «Папка на машине»
// (машины и папки по частоте из roster, пресеты, путь, machine.dirs). Снизу — поле ввода: имя обязательно и подставлено из папки,
// чипы «Профиль» и модель · усилие · слот, «Точки в R2» (выключены), задача — необязательно.
// «Открыть» = session.open; включено «в R2» — session.r2; есть задача — session.prompt; затем карточка. Своих данных нет.
import { useEffect, useRef, useState } from "react";
import type { App, AppModule, ScreenProps, SessionRecord } from "@switchboard/web-core";
import type {} from "@switchboard/web-labels";
import { machineOf } from "@switchboard/protocol";
import { Btn, effortName as effName, EFFORTS, MODELS, plural, profileName as short, projectOf } from "@switchboard/web-ui";
import css from "./open.css";

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

type Slots = Record<string, { account: string | null; wait?: number | null; sessions: string[] }>;
type Profiles = Record<string, { model?: string | null; effort?: string | null; about?: string }>;
type Browse = { m: string; path: string; dirs: string[]; err: string; mq: string; dq: string; step: "m" | "d" };

/** Состояние формы: один снимок, правка — новым снимком. */
type Form = {
  machine: string;
  dir: string;
  name: string;
  nameSet: boolean;
  nameErr: string;
  err: string;
  profile: string | null;
  model: string;
  effort: string;
  modelSet: boolean;
  slot: string;
  r2: boolean;
  text: string;
  sending: boolean;
  where: "recent" | "browse";
  q: string;
  pq: string;
  pop: "" | "prof" | "model";
  brw: Browse | null;
  slots: Slots | null;
  profiles: Profiles | null;
  refused: Record<string, string>;
};

const EMPTY: Form = { machine: "", dir: "", name: "", nameSet: false, nameErr: "", err: "", profile: null, model: "", effort: "", modelSet: false, slot: "", r2: false, text: "", sending: false, where: "recent", q: "", pq: "", pop: "", brw: null, slots: null, profiles: null, refused: {} };

/** Управляемое поле читает значение из onInput; onChange нужен только React для правила поля со значением. */
const keep = () => {};

/** Путь на шаг вверх: «~/Projects» → «~», «C:/x» → «C:/». */
export function up(p: string): string {
  const parts = p.replace(/[\\/]+$/, "").split(/[\\/]/);
  if (parts.length <= 1) return p.startsWith("/") ? "/" : p;
  parts.pop();
  const out = parts.join("/");
  return out === "" ? "/" : /^[A-Za-z]:$/.test(out) ? out + "/" : out;
}
export const join = (p: string, n: string) => `${p.replace(/[\\/]+$/, "")}/${n}`;
const slash = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
const under = (dir: string, path: string) => {
  const d = slash(dir);
  const q = slash(path);
  return d === q || d.startsWith(`${q}/`);
};
/** Время сброса слота: секунды или миллисекунды эпохи → ЧЧ:ММ. */
const hm = (t: number) => {
  const d = new Date(t < 1e12 ? t * 1000 : t);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};
const dirOf = (s: SessionRecord) => (typeof s.dir === "string" && s.dir ? s.dir : "~");

/** Новый модуль со своей памятью (в выпуске — один; в тестах — на каждый прогон). */
export function createOpen(): AppModule {
  let app: App;

  const sessions = (): SessionRecord[] => app.roster()?.sessions ?? [];
  const machines = () => (app.roster()?.machines ?? []).map((m) => m.machine).filter((m) => app.can(m, "session.open") === true);
  const can = (m: string, n: string) => app.can(m, n) === true;
  const taken = (cs: string) => sessions().some((s) => s.callsign === cs);

  /** частота — из roster: сессий на машине и под папкой, включая остановленные */
  const machineUse = (m: string) => sessions().filter((s) => machineOf(s.callsign) === m).length;
  const folderUse = (m: string, path: string) => sessions().filter((s) => machineOf(s.callsign) === m && under(dirOf(s), path)).length;
  /** пресеты: папки сессий машины и папки над ними — по частоте, потом короче; дом — последним: под ним всё */
  function presetsOf(m: string): string[] {
    const c = new Set<string>();
    for (const s of sessions()) {
      if (machineOf(s.callsign) !== m) continue;
      const d = dirOf(s);
      if (d === "~") continue;
      c.add(d);
      const parent = up(d);
      if (parent !== d && parent !== "~") c.add(parent);
    }
    return [...[...c].sort((a, b) => folderUse(m, b) - folderUse(m, a) || a.length - b.length || a.localeCompare(b)).slice(0, 7), "~"];
  }

  function Open({ params }: ScreenProps) {
    const [f, setF] = useState<Form>(EMPTY);
    // логика читает последний снимок: ответы приходят позже отрисовки
    const now = useRef(f);
    const s = () => now.current;
    const set = (patch: Partial<Form>) => {
      now.current = { ...now.current, ...patch };
      setF(now.current);
    };

    // экран следит за roster и именами машин: выборка перерисует его, когда они изменятся
    useRosterWatch();
    const online = app.use(machines);
    const mLabel = (m: string) => app.mark("label.machine", m) ?? { text: `@${m}`, human: false };

    /** имя — главное и обязательное: подставлено из папки, пока человек его не правил; занятое на машине — с номером */
    function suggestName(): string {
      const base = projectOf(s().dir).replace(/[^A-Za-z0-9._-]/g, "").toLowerCase() || "task";
      let n = base;
      for (let i = 2; taken(`${n}@${s().machine}`); i++) n = `${base}-${i}`;
      return n;
    }

    function setProfile(id: string | null) {
      if (s().modelSet) return set({ profile: id });
      const p = id ? s().profiles?.[id] : undefined;
      set({ profile: id, model: p?.model ?? "", effort: p?.effort ?? "" });
    }
    /** профиль по умолчанию: профиль сессии этого места, иначе одноимённый проекту, если он у машины есть */
    function defaultProfile() {
      const { profile, profiles, machine, dir } = s();
      const have = profiles ?? {};
      if (profile && have[profile]) return setProfile(profile);
      const used = sessions().find((x) => machineOf(x.callsign) === machine && dirOf(x) === dir && (x.profile as { id?: string } | null)?.id && have[(x.profile as { id: string }).id]);
      setProfile(used ? (used.profile as { id: string }).id : (Object.keys(have).find((id) => short(id) === projectOf(dir)) ?? null));
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

    function pickPlace(m: string, d: string) {
      const same = m === s().machine;
      set({ machine: m, dir: d, brw: null, where: "recent", err: "", pop: "", q: "" });
      if (!s().nameSet) set({ name: suggestName() });
      if (same) defaultProfile();
      else void loadMachine();
    }

    async function browseTo(path: string) {
      const b = s().brw;
      if (!b) return;
      set({ brw: { ...b, path, dq: "", err: "", dirs: [] } });
      const r = await app.request<{ path: string; dirs: string[] }>("machine.dirs", { machine: b.m, path });
      const cur = s().brw;
      if (!cur || cur.m !== b.m || cur.path !== path) return;
      if (r.ok) set({ brw: { ...cur, path: r.result.path, dirs: r.result.dirs.filter((d) => !d.startsWith(".")) } });
      else set({ brw: { ...cur, err: `machine.dirs: ${r.error}` } });
    }

    function openBrowse() {
      set({ where: "browse" });
      if (s().brw) return;
      // обзор открывается на машине места или самой частой, в самой частой её папке
      const { machine, dir } = s();
      const m = machine || [...machines()].sort((a, b) => machineUse(b) - machineUse(a) || a.localeCompare(b))[0];
      if (!m) return;
      const path = machine ? dir : presetsOf(m)[0];
      set({ brw: { m, path, dirs: [], err: "", mq: "", dq: "", step: machine ? "d" : "m" } });
      void browseTo(path);
    }

    async function start() {
      const { name } = s();
      const nameErr = !name ? "нужно имя" : !NAME.test(name) ? "латиница, цифры, точка, - и _" : "";
      set({ nameErr, err: "" });
      if (nameErr) return;
      set({ sending: true });
      const { machine, dir, slot, profile, modelSet, model, effort, r2, text } = s();
      const body: Record<string, unknown> = { machine, name: name.toLowerCase(), dir };
      if (slot) body.slot = slot;
      if (profile) body.profile = profile;
      if (modelSet && model) body.model = model;
      if (modelSet && effort) body.effort = effort;
      const r = await app.request<{ callsign: string }>("session.open", body);
      if (!r.ok) {
        set({ sending: false, ...(r.error === "name_taken" ? { nameErr: `name_taken: на ${machine} уже есть ${name.toLowerCase()}@${machine}` } : { err: `session.open: ${r.error}` }) });
        return;
      }
      const callsign = r.result.callsign;
      // пометку «в R2» держит host-points машины новой сессии; manage о ней не знает
      if (r2 && can(machine, "session.r2")) {
        const m = await app.request("session.r2", { callsign, on: true });
        if (!m.ok) app.toast(`${callsign}: «в R2» не включилось — ${m.error}`);
      }
      // задача — необязательно: без неё сессия открыта и ждёт ввода
      if (text.trim()) {
        const p = await app.request("session.prompt", { callsign, text: text.trim(), attachments: [] });
        if (!p.ok) app.toast(`${callsign}: задача не ушла — ${p.error}`);
      }
      set({ sending: false });
      app.open("card", { callsign });
    }

    /** место из адреса: машина может прийти своим соединением позже первого roster */
    useEffect(() => {
      if (s().machine || !params.machine || !online.includes(params.machine)) return;
      pickPlace(params.machine, params.dir || "~");
    }, [online.join(" ")]);

    // поиск мест — сразу под рукой, если место не задано адресом
    const qRef = useRef<HTMLInputElement>(null);
    useEffect(() => {
      if (!params.machine) qRef.current?.focus();
    }, []);

    // ───── где ─────
    function recentPane() {
      const ql = f.q.trim().toLowerCase();
      const on = new Set(online);
      const seen = new Map<string, { project: string; m: string; dir: string }>();
      for (const x of sessions()) {
        const m = machineOf(x.callsign) ?? "";
        if (!on.has(m)) continue;
        seen.set(`${m}|${dirOf(x)}`, { project: projectOf(dirOf(x)), m, dir: dirOf(x) });
      }
      const all = [...seen.values()].sort((a, b) => a.project.localeCompare(b.project) || a.m.localeCompare(b.m));
      const plc = (x: { m: string; dir: string }, checked: boolean, key: string) => {
        const l = mLabel(x.m);
        return (
          <button key={key} className="op-plc" role="radio" aria-checked={checked} data-machine={x.m} data-dir-pick={x.dir} onClick={() => pickPlace(x.m, x.dir)}>
            <span className="rd" />
            <span className={"m" + (l.human ? " hum" : "")}>{l.text}</span>
            <span className="p">{x.dir}</span>
          </button>
        );
      };
      const list = [];
      let group = "";
      let shown = 0;
      for (const x of all) {
        if (ql ? !`${x.project} ${x.m} ${mLabel(x.m).text} ${x.dir}`.toLowerCase().includes(ql) : x.m === f.machine && x.dir === f.dir) continue;
        if (x.project !== group) {
          group = x.project;
          list.push(
            <div key={`g:${group}`} className="op-g">
              {group}
            </div>,
          );
        }
        list.push(plc(x, x.m === f.machine && x.dir === f.dir, `${x.m}|${x.dir}`));
        shown++;
      }
      return (
        <>
          <input ref={qRef} className="op-flt" data-f="q" value={f.q} placeholder={`Проект, машина или папка · ${all.length}`} autoComplete="off" aria-label="Найти место" onChange={keep} onInput={(e) => set({ q: e.currentTarget.value })} />
          {/* выбранное место — первым, чтобы при длинном списке его было видно */}
          {f.machine && !ql ? <div className="op-g">{`выбрано · ${projectOf(f.dir)}`}</div> : null}
          {f.machine && !ql ? plc({ m: f.machine, dir: f.dir }, true, "picked") : null}
          {list}
          {!all.length || (ql && !shown) ? <div className="op-none">мест нет</div> : null}
        </>
      );
    }

    function machinesPane(b: Browse) {
      const ql = b.mq.trim().toLowerCase();
      const ms = online.filter((m) => !ql || `${m} ${mLabel(m).text}`.toLowerCase().includes(ql)).sort((x, y) => machineUse(y) - machineUse(x) || x.localeCompare(y));
      return (
        <div className="op-bm">
          <input className="op-flt" data-f="mq" value={b.mq} placeholder={`Машина · ${online.length}`} autoComplete="off" aria-label="Найти машину" onChange={keep} onInput={(e) => set({ brw: { ...b, mq: e.currentTarget.value } })} />
          <div className="op-bl" role="listbox" aria-label="Машины">
            {ms.length ? (
              ms.map((m) => {
                const n = machineUse(m);
                const l = mLabel(m);
                return (
                  <button
                    key={m}
                    role="option"
                    aria-selected={b.m === m}
                    data-machine={m}
                    onClick={() => {
                      set({ brw: { ...b, m, step: "d" } });
                      void browseTo(presetsOf(m)[0]);
                    }}
                  >
                    <b className={l.human ? "hum" : undefined}>{l.text}</b>
                    <span className="k">{n ? `${n} ${plural(n, "сессия", "сессии", "сессий")}` : ""}</span>
                  </button>
                );
              })
            ) : (
              <span className="op-none">машин нет</span>
            )}
          </div>
        </div>
      );
    }

    function foldersPane(b: Browse) {
      const segs = b.path.split("/");
      const dq = b.dq.trim().toLowerCase();
      const dirs = b.dirs.filter((d) => !dq || d.toLowerCase().includes(dq)).sort((x, y) => folderUse(b.m, join(b.path, y)) - folderUse(b.m, join(b.path, x)) || x.localeCompare(y));
      const go = (v: string) => void browseTo(v.trim() || "~");
      return (
        <div className="op-bf">
          {app.wide ? null : (
            <button className="op-bk" onClick={() => set({ brw: { ...b, step: "m" } })}>
              {`‹ ${mLabel(b.m).text}`}
            </button>
          )}
          <div className="op-pre">
            {presetsOf(b.m).map((p) => {
              const n = folderUse(b.m, p);
              return (
                <button key={p} aria-pressed={b.path === p} data-preset={p} onClick={() => void browseTo(p)}>
                  {p}
                  {n ? <span className="n">{String(n)}</span> : null}
                </button>
              );
            })}
          </div>
          <PathInput
            path={b.path}
            label={`Путь на ${mLabel(b.m).text}`}
            onEnter={go}
            onLeave={(v) => {
              if (v.trim() !== b.path) go(v);
            }}
          />
          <div className="op-cr">
            {segs.flatMap((x, i) => [
              i ? <span key={`s${i}`}>/</span> : null,
              <button key={`b${i}`} data-crumb={segs.slice(0, i + 1).join("/")} onClick={() => void browseTo(segs.slice(0, i + 1).join("/") || "/")}>
                {x || "/"}
              </button>,
            ])}
            <input data-f="dq" value={b.dq} placeholder="фильтр" autoComplete="off" aria-label="Фильтр папок" onChange={keep} onInput={(e) => set({ brw: { ...b, dq: e.currentTarget.value } })} />
          </div>
          {b.err ? (
            <div className="op-err" role="alert">
              {b.err}
            </div>
          ) : null}
          <div className="op-dl">
            {dirs.map((d) => {
              const n = folderUse(b.m, join(b.path, d));
              return (
                <button key={d} data-dir={d} onClick={() => void browseTo(join(b.path, d))}>
                  <span>{`▸ ${d}`}</span>
                  {n ? <span className="n">{String(n)}</span> : null}
                </button>
              );
            })}
            {!dirs.length && !b.err ? <span className="op-none">пусто</span> : null}
          </div>
          <div className="op-bfoot">
            <span className="w">{`${mLabel(b.m).text} ${b.path}`}</span>
            <Btn pri data-act="pick" onClick={() => pickPlace(b.m, b.path)}>
              {`Выбрать ${segs.at(-1) || b.path}`}
            </Btn>
          </div>
        </div>
      );
    }

    /** пульт — машины и папки рядом; телефон — сначала машина, потом папки */
    function browsePane() {
      const b = f.brw;
      if (!b) return <div className="op-none">машин нет</div>;
      if (!app.wide) return <div className="op-brw one">{b.step === "m" ? machinesPane(b) : foldersPane(b)}</div>;
      return (
        <div className="op-brw">
          {machinesPane(b)}
          {foldersPane(b)}
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

    const disabled = f.sending || !f.machine || !f.name;
    const l = f.machine ? mLabel(f.machine) : null;
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
          <div className="op-where" role="tablist" aria-label="Где">
            <button role="tab" aria-selected={f.where === "recent"} data-where="recent" onClick={() => set({ where: "recent" })}>
              Недавние
            </button>
            <button role="tab" aria-selected={f.where === "browse"} data-where="browse" onClick={openBrowse}>
              Папка на машине
            </button>
          </div>
          {f.where === "browse" ? browsePane() : recentPane()}
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
          <div className={"op-nm" + (f.nameErr ? " bad" : "")}>
            <label htmlFor="op-name">Имя</label>
            <input
              id="op-name"
              data-f="name"
              value={f.name}
              required
              aria-required="true"
              autoComplete="off"
              spellCheck={false}
              placeholder={f.machine ? "нужно имя" : "сначала место"}
              disabled={!f.machine}
              onChange={keep}
              onInput={(e) => set({ name: e.currentTarget.value.trim(), nameSet: true, nameErr: "" })}
            />
            {l ? <span className={"at" + (l.human ? " hum" : "")}>{l.text}</span> : null}
          </div>
          {f.nameErr ? (
            <span className="op-err" role="alert">
              {f.nameErr}
            </span>
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
              {f.text.trim() ? "Начать" : "Открыть"}
            </Btn>
          </div>
        </div>
      </div>
    );
  }

  /** Поле пути: своё значение, пока человек правит; новый путь обзора — значение поля. */
  function PathInput({ path, label, onEnter, onLeave }: { path: string; label: string; onEnter(v: string): void; onLeave(v: string): void }) {
    const ref = useRef<HTMLInputElement>(null);
    useEffect(() => {
      if (ref.current) ref.current.value = path;
    }, [path]);
    return (
      <input
        ref={ref}
        data-f="path"
        defaultValue={path}
        autoComplete="off"
        spellCheck={false}
        aria-label={label}
        onKeyDown={(e) => {
          if (e.key === "Enter") onEnter(e.currentTarget.value);
        }}
        onBlur={(e) => onLeave(e.currentTarget.value)}
      />
    );
  }

  /** Перерисовка экрана при новом roster и новых именах машин: выборка отдаёт то, что экран читает. */
  function useRosterWatch() {
    app.use(() => ({ sessions: sessions(), names: (app.roster()?.machines ?? []).map((m) => app.mark("label.machine", m.machine)) }));
  }

  return {
    screens: { open: { label: "Новая сессия", view: Open, head: () => ({ title: "Новая сессия" }) } },
    css,
    start(a) {
      app = a;
    },
  };
}
