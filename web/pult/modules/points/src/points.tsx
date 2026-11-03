// pult-points — точки сессий с пометкой «в R2»: обзор реестра, вкладка «Точки» карточки, перенос, копия,
// смена папки, откат и «пожар». Своих данных не хранит: линия, ветки, срок и хозяин — от реестра points,
// подъём и точки — host-points машины. Шаги ведёт страница: каждый запрос — после ответа предыдущего.
// Ответы реестра — в памяти модуля; экраны читают их выборкой, состояние окон — у самого экрана.
import { Fragment, useEffect, useRef, useState } from "react";
import type { App, AppModule, ScreenProps, SessionRecord } from "@switchboard/web-core";
import type {} from "@switchboard/web-board";
import type {} from "@switchboard/web-labels";
import { machineOf } from "@switchboard/protocol";
import { Btn, H4, hhmm, In, M, Note, Opts, OptsLabel, Page, PageHead, PickOne, plural, Row, Sec } from "@switchboard/web-ui";
import css from "./points.css";

type FleetSession = { sid: string; callsign?: string; dir?: string; owner: string; head: { id: number; at: number }; points: number; branches: number };
type Fleet = { sessions: FleetSession[]; r2: { bytes: number; blocks: number }; sweep: { at: number; blocks: number; bytes: number } | null };
type Git = { state?: string; files?: number; branch?: string };
type LPoint = { id: number; at: number; machine: string; why: string; base: number | null; callsign?: string; dir?: string; msgs?: number; bytes?: number; git?: Git; line: boolean; until: number | null };
type Line = { owner: string | null; head: number | null; points: LPoint[] };
type Full = { id: number; last?: unknown[] };
type Check = { folder: string; files?: number; branch?: string | null; sessions?: string[] };
type Dlg = {
  kind: "move" | "copy" | "dir" | "rb";
  target: string;
  from: "fresh" | number;
  slot: string;
  slots: string[] | null;
  dir: string;
  name: string;
  files: "point" | "keep";
  interrupt: boolean;
  check: Check | { error: string } | null;
  phase: "" | "run" | "done" | "err";
  msg: string;
};
type FireRow = { s: FleetSession; dir: string; slot: string; check: Check | { error: string } | null; st: string };
type FireDlg = { from: string; target: string; rows: FireRow[]; slots: string[]; run: boolean; k: number };
type MoveDlg = { s: FleetSession } & Dlg;

const r2Of = (s: SessionRecord | undefined) => s?.r2 as { error?: string; at?: number } | undefined;
const nameOf = (callsign: string) => callsign.split("@")[0];
const mb = (b: number) => `${Math.round(b / 1048576)} МБ`;
const day = (t: number) => new Date(t).toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
function ago(t: number): string {
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return "только что";
  if (m < 60) return `${m} мин назад`;
  const hr = Math.floor(m / 60);
  return hr < 24 ? `${hr} ч ${m % 60} мин назад` : day(t);
}
/** Слова отказа host-points и points → строка на экране. */
function say(w: string, cs = "", target = "", src = ""): string {
  const t: Record<string, string> = {
    waiting: `${cs || "Сессия"} ждёт ответа человека — после ответа или с «прервать»`,
    bad_dir: "Правки точки сюда не встанут — другой репозиторий; выберите другую папку или «оставить как есть»",
    bad_point: "Точка не открылась — причина в журнале машины",
    not_owner: "Сессию уже подняли на другой машине",
    open_failed: target ? `Не поднялась на ${target}${src && src !== target ? ` — снова идёт на ${src}` : ""}` : "Не поднялась",
    not_r2: "Сессия не в R2",
    running: "Сессия ещё идёт — сначала точка со стопом",
    name_taken: "Имя занято на этой машине",
    offline: "Машины нет на связи",
  };
  return t[w] ?? w;
}
/** Что будет с папкой на целевой машине — ответ points.raise с dryRun. */
function folderText(c: Check, m: string): string {
  switch (c.folder) {
    case "same":
      return "тот же репозиторий, своих правок нет — правки точки применятся";
    case "dirty":
      return `тот же репозиторий, но в нём свои правки (${c.files ?? "?"} ${plural(c.files ?? 0, "файл", "файла", "файлов")}): правки точки НЕ применятся, ваши файлы останутся`;
    case "empty":
      return `нет на ${m} — будет клон репозитория и правки точки поверх`;
    case "shared":
      return `здесь же ${(c.sessions ?? []).join(", ")} — в этой папке будут ${(c.sessions?.length ?? 0) + 1} сессии`;
    case "nogit":
      return "в точке нет git — файлы останутся как есть";
    case "other":
      return "Другой репозиторий — выберите другую папку";
    default:
      return c.folder;
  }
}

/** Проверка папки диалога: отказ или что будет с папкой. */
function CheckLine({ d }: { d: Dlg }) {
  if (!d.check) return null;
  if ("error" in d.check) {
    return (
      <Note tone="bad" data-check="error">
        {say(d.check.error)}
      </Note>
    );
  }
  return (
    <Note tone={d.check.folder === "other" ? "bad" : d.check.folder === "dirty" ? "wait" : "ok"} data-check={d.check.folder}>
      {folderText(d.check, d.target)}
    </Note>
  );
}

/** Поле папки: каждая буква — в onInput, готовое значение (браузерное change: уход с поля, Enter) — в onCommit. */
function DirInput({ value, onInput, onCommit }: { value: string; onInput(v: string): void; onCommit(v: string): void }) {
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const el = field.current!;
    const commit = () => onCommit(el.value);
    el.addEventListener("change", commit);
    return () => el.removeEventListener("change", commit);
  });
  return <In ref={field} mono data-f="dir" defaultValue={value} onInput={(e) => onInput(e.currentTarget.value)} />;
}

/** Новый модуль со своей памятью; экран session.points — вкладка «Точки» в месте card.tab карточки. */
export function createPoints(): AppModule {
  let app: App;
  let fleet: Fleet | null = null;
  /** слово отказа последнего points.list реестра */
  let fleetRefused = "";
  const lines = new Map<string, Line>();
  const full = new Map<number, Full>();
  const left = new Map<string, number>();
  /** номер изменения памяти модуля: экраны читают его выборкой */
  let rev = 0;
  const changed = () => {
    rev++;
    app.changed();
  };

  const online = () => new Set((app.roster()?.machines ?? []).map((m) => m.machine));
  const live = () => new Set((app.roster()?.sessions ?? []).map((s) => s.callsign));
  /** Поднятая сессия встаёт в проект исходной: команду записи держит «Работа». */
  function keepProject(from: string | null | undefined, to: string) {
    const project = from ? app.mark("project.of", from)?.id : undefined;
    if (project) app.open("board.assign", { callsign: to, project });
  }
  const raisers = () => (app.roster()?.machines ?? []).filter((m) => m.contract?.["points.raise"] !== undefined).map((m) => m.machine);

  /** Выбор машины подъёма: выбранная и машины проекта сессии (метки web-board) — кнопками, остальные — списком. */
  function PickMachine({ cur, callsign, on }: { cur: string; callsign: string | undefined; on(m: string): void }) {
    const pm = app.use(() => {
      const project = callsign ? app.mark("project.of", callsign)?.id : null;
      return project ? (app.mark("project.machines", project) ?? []) : [];
    });
    const all = app.use(raisers);
    return (
      <Opts>
        <PickOne all={all} near={pm} cur={cur} on={on} select={{ "data-f": "target", "aria-label": "Другая машина" }} />
      </Opts>
    );
  }

  async function loadFleet() {
    const r = await app.request<Fleet>("points.list", {});
    if (r.ok) fleet = r.result;
    fleetRefused = r.ok ? "" : r.error;
    // «пожар»: машины хозяина нет в roster — когда ушла, скажет журнал флота
    const on = online();
    const fire = new Set((fleet?.sessions ?? []).filter((s) => !on.has(s.owner)).map((s) => s.owner));
    await Promise.all(
      [...fire].map(async (m) => {
        const j = await app.request<{ events: Array<{ t: number; ev: string }> }>("ledger.read", { machine: m, limit: 1 });
        const e = j.ok ? j.result.events.find((x) => x.ev === "machine.left") : undefined;
        if (e) left.set(m, e.t);
      }),
    );
    changed();
  }

  /** Слоты машины; отказ — словом проверки: без него подъём ушёл бы без слота, на вход машины. */
  async function slotsOf(m: string): Promise<string[] | { error: string }> {
    if (!app.can(m, "machine.slots")) return [];
    const r = await app.request<{ slots: Record<string, unknown> }>("machine.slots", { machine: m });
    return r.ok ? Object.keys(r.result.slots ?? {}) : { error: `machine.slots: ${r.error}` };
  }

  async function dry(m: string, sid: string, point: number, dir: string): Promise<Check | { error: string }> {
    const r = await app.request<Check>("points.raise", { machine: m, sid, point, dir, files: "point", dryRun: true });
    return r.ok ? r.result : { error: r.error };
  }

  // ───── обзор ─────
  /** Строка сессии в R2: имя — своей выборкой, правка имени перерисует только её. */
  function R2Row({ s, save }: { s: FleetSession; save(callsign: string): void }) {
    const label = app.use(() => app.mark("label.session", s.callsign ?? ""));
    return (
      <div className="pt-row" data-sid={s.sid}>
        <span>
          <b>{label?.text ?? s.callsign}</b>
          {` ${ago(s.head.at)} · №${s.head.id}`}
        </span>
        {app.can(s.owner, "points.save") ? <Btn onClick={() => save(s.callsign!)}>Сохранить сейчас</Btn> : null}
      </div>
    );
  }

  function Overview() {
    app.use(() => rev);
    const roster = app.use(() => app.roster());
    const [q, setQ] = useState("");
    const [del, setDel] = useState<{ sid: string; name: string; typed: string } | null>(null);
    const [done, setDone] = useState("");
    const [fire, setFire] = useState<FireDlg | null>(null);
    const [move, setMove] = useState<MoveDlg | null>(null);

    useEffect(() => void loadFleet(), []);

    async function save(callsign: string) {
      const r = await app.request<{ point: number; same: boolean }>("points.save", { callsign });
      app.toast(r.ok ? `${callsign}: точка №${r.result.point}${r.result.same ? " — та же" : ""}` : `${callsign}: ${say(r.error, callsign)}`, r.ok ? "ok" : "bad");
      if (r.ok) await loadFleet();
    }

    async function remove(d: { sid: string; name: string }) {
      const r = await app.request<{ points: number }>("points.delete", { sid: d.sid });
      if (!r.ok) return setDone(`points.delete: ${r.error}`);
      setDel(null);
      setDone(`${d.name} удалена — ${r.result.points} ${plural(r.result.points, "точка", "точки", "точек")}`);
      if (fleet) fleet = { ...fleet, sessions: fleet.sessions.filter((s) => s.sid !== d.sid) };
      changed();
      void loadFleet();
    }

    async function openFire(from: string) {
      const target = raisers()[0] ?? "";
      const rows: FireRow[] = (fleet?.sessions ?? []).filter((s) => s.owner === from).map((s) => ({ s, dir: s.dir ?? "~", slot: "", check: null, st: "" }));
      setFire({ from, target, rows, slots: [], run: false, k: 0 });
      await fireTarget(target, rows);
    }
    async function fireTarget(target: string, rows: FireRow[]) {
      setFire((f) => f && { ...f, target });
      const sl = await slotsOf(target);
      if (!Array.isArray(sl)) return setFire((f) => f && { ...f, slots: [], rows: f.rows.map((r) => ({ ...r, check: sl })) });
      setFire((f) => f && { ...f, slots: sl, rows: f.rows.map((r) => ({ ...r, slot: sl[0] ?? "" })) });
      const checks = await Promise.all(rows.map((r) => dry(target, r.s.sid, r.s.head.id, r.dir)));
      setFire((f) => f && { ...f, rows: f.rows.map((r, i) => ({ ...r, check: checks[i] })) });
    }
    /** Перенос сессий пропавшей машины: по одной, следующая — после ответа на предыдущую; points.save не шлётся. */
    async function runFire(f: FireDlg) {
      setFire((x) => x && { ...x, run: true });
      const setSt = (i: number, st: string, k = 0) => setFire((x) => x && { ...x, k: x.k + k, rows: x.rows.map((r, n) => (n === i ? { ...r, st } : r)) });
      for (const [i, r] of f.rows.entries()) {
        setSt(i, "поднимается…");
        const x = await app.request<{ callsign: string }>("points.raise", { machine: f.target, sid: r.s.sid, point: r.s.head.id, dir: r.dir, ...(r.slot ? { slot: r.slot } : {}), files: "point" });
        if (x.ok) keepProject(r.s.callsign, x.result.callsign);
        setSt(i, x.ok ? `готова — ${x.result.callsign}` : x.error === "not_owner" ? "уже подняли на другой машине" : `не поднялась: ${say(x.error)}`, x.ok ? 1 : 0);
      }
      void loadFleet();
    }

    async function runMove(d: MoveDlg) {
      setMove((m) => m && { ...m, phase: "run", msg: `${d.target} поднимает сессию из точки…` });
      const x = await app.request<{ callsign: string }>("points.raise", { machine: d.target, sid: d.s.sid, point: d.s.head.id, dir: d.dir, ...(d.slot ? { slot: d.slot } : {}), files: "point" });
      setMove((m) => m && { ...m, phase: x.ok ? "done" : "err", msg: x.ok ? `${nameOf(d.s.callsign ?? "")} поднята: ${x.result.callsign}` : say(x.error, "", d.target) });
      if (x.ok) {
        keepProject(d.s.callsign, x.result.callsign);
        void loadFleet();
      }
    }
    async function openMove(s: FleetSession) {
      const target = raisers()[0] ?? "";
      const dir = s.dir ?? "~";
      setMove({ s, kind: "move", target, from: s.head.id, slot: "", slots: null, dir, name: "", files: "point", interrupt: false, check: null, phase: "", msg: "" });
      await moveTarget(target, s, dir);
    }
    async function moveTarget(target: string, s: FleetSession, dir: string) {
      setMove((m) => m && { ...m, target });
      const sl = await slotsOf(target);
      const slots = Array.isArray(sl) ? sl : [];
      const check = Array.isArray(sl) ? await dry(target, s.sid, s.head.id, dir) : sl;
      setMove((m) => m && { ...m, slots, slot: slots[0] ?? "", check });
    }

    const page = (
      <PageHead title="Точки">
        <Note>сохранённые состояния сессий — из них сессию поднимают на любой машине</Note>
      </PageHead>
    );
    const refused = fleetRefused ? (
      <Note tone="bad" role="alert">
        {`points.list: ${fleetRefused}`}
      </Note>
    ) : null;
    if (!fleet) {
      return (
        <Page>
          {page}
          {refused}
          {fleetRefused ? null : <Note>…</Note>}
        </Page>
      );
    }

    const on = online();
    const lv = live();
    const ms = raisers();
    const fires = new Map<string, FleetSession[]>();
    const only: FleetSession[] = [];
    const inR2: FleetSession[] = [];
    for (const s of fleet.sessions) {
      if (!on.has(s.owner)) fires.set(s.owner, [...(fires.get(s.owner) ?? []), s]);
      else if (s.callsign && lv.has(s.callsign)) inR2.push(s);
      else only.push(s);
    }
    inR2.sort((a, b) => a.head.at - b.head.at);
    const total = roster?.sessions.length ?? 0;
    const outside = (roster?.sessions ?? []).filter((s) => !r2Of(s)).map((s) => s.callsign);
    const shown = only.filter((s) => !q || [s.callsign, s.dir, day(s.head.at)].some((x) => x?.toLowerCase().includes(q.toLowerCase()))).sort((a, b) => b.head.at - a.head.at);

    function fireView(f: FireDlg) {
      const ready = f.rows.every((r) => r.check && !("error" in r.check) && r.check.folder !== "other");
      return (
        <Sec dlg data-dlg="fire">
          <H4>{`Перенести сессии ${f.from} на другую машину`}</H4>
          {f.run ? (
            <Sec tone={f.k === f.rows.length ? "ok" : "wait"} role="status" data-progress={`${f.k}/${f.rows.length}`}>
              <b>{`Перенос с ${f.from} на ${f.target}: ${f.k} из ${f.rows.length} готовы${f.k < f.rows.length && f.rows.some((r) => !r.st || r.st.endsWith("…")) ? " — не закрывайте страницу" : ""}`}</b>
            </Sec>
          ) : (
            <Row label="Куда">
              <PickMachine cur={f.target} callsign={f.rows[0]?.s.callsign ?? undefined} on={(m) => void fireTarget(m, f.rows)} />
            </Row>
          )}
          {f.rows.map((r) => (
            <Sec key={r.s.sid} data-row={nameOf(r.s.callsign ?? r.s.sid)}>
              <b>{nameOf(r.s.callsign ?? r.s.sid)}</b>
              <Note>{`точка ${hhmm(r.s.head.at)} · №${r.s.head.id}`}</Note>
              {f.run ? (
                <Note>{r.st}</Note>
              ) : (
                <Opts>
                  <Note>{`Слот на ${f.target}: ${r.slot || "без слота"}`}</Note>
                  <M>{r.dir}</M>
                </Opts>
              )}
              {f.run ? null : r.check ? "error" in r.check ? <Note tone="bad">{say(r.check.error)}</Note> : <Note>{folderText(r.check, f.target)}</Note> : <Note>проверяю папку…</Note>}
            </Sec>
          ))}
          <Note>Каждая поднимется из своей последней точки, по одной, пока страница открыта. Закроете — оставшиеся ждут на точках, плашка останется.</Note>
          {f.run ? (
            <Opts>
              <Btn onClick={() => setFire(null)}>Закрыть</Btn>
            </Opts>
          ) : (
            <Opts>
              <Btn onClick={() => setFire(null)}>Отмена</Btn>
              <Btn pri disabled={!ready || !f.target} onClick={() => void runFire(f)}>{`Перенести ${f.rows.length} из ${f.rows.length} на ${f.target}`}</Btn>
            </Opts>
          )}
        </Sec>
      );
    }

    function moveView(d: MoveDlg) {
      return (
        <Sec dlg data-dlg="raise">
          <b>{`Поднять ${nameOf(d.s.callsign ?? "")} из точки №${d.s.head.id}`}</b>
          <Row label="Машина">
            <PickMachine cur={d.target} callsign={d.s.callsign ?? undefined} on={(m) => void moveTarget(m, d.s, d.dir)} />
          </Row>
          <Row label="Слот">
            <span>{d.slot || "без слота"}</span>
          </Row>
          <Row label="Папка">
            <M>{d.dir}</M>
          </Row>
          <CheckLine d={d} />
          {d.msg ? (
            <Note tone={d.phase === "err" ? "bad" : d.phase === "done" ? "ok" : undefined} role="status">
              {d.msg}
            </Note>
          ) : null}
          <Opts>
            <Btn onClick={() => setMove(null)}>{d.phase === "done" ? "Закрыть" : "Отмена"}</Btn>
            {d.phase !== "done" ? (
              <Btn pri disabled={d.phase === "run" || !d.check || "error" in d.check || d.check.folder === "other"} onClick={() => void runMove(d)}>
                {`Поднять на ${d.target}`}
              </Btn>
            ) : null}
          </Opts>
        </Sec>
      );
    }

    return (
      <Page>
        {page}
        {refused}
        {[...fires].map(([m, list]) => {
          const t = left.get(m);
          return (
            <Sec key={m} tone="bad" data-fire={m}>
              <b>{`${m} не на связи${t ? ` с ${hhmm(t)}` : ""} · ${list.length} ${plural(list.length, "сессия ждёт", "сессии ждут", "сессий ждут")} на последних точках`}</b>
              <Note>{`Что ${m} допишет после точек, вернётся веткой, если он появится.`}</Note>
              {!fire && ms.length ? (
                <Opts>
                  <Btn pri onClick={() => void openFire(m)}>
                    Перенести на другую машину…
                  </Btn>
                </Opts>
              ) : null}
            </Sec>
          );
        })}
        {fire ? fireView(fire) : null}
        <Opts data-summary="">
          <b>{`${inR2.length} ${plural(inR2.length, "сессия", "сессии", "сессий")} в R2 из ${total} на машинах`}</b>
          {[...fires].map(([m, l]) => (
            <Note key={m} tone="bad">{`· ${l.length} на ${m} — нет связи`}</Note>
          ))}
          <Note>{`· ${only.length} только в R2`}</Note>
        </Opts>
        <Sec>
          <H4>Последняя точка — давнее всех сверху</H4>
          {inR2.map((s) => (
            <R2Row key={s.sid} s={s} save={(c) => void save(c)} />
          ))}
          {inR2.length ? null : <Note>Сессий в R2 на связи нет.</Note>}
        </Sec>
        {outside.length ? <Note>{`${outside.join(", ")} не в R2 — точек и переноса у них нет; включить — вкладка «Точки» сессии.`}</Note> : null}
        <Sec data-only="">
          <PageHead>
            <H4>{`Только в R2 · ${only.length}`}</H4>
            <In data-f="q" placeholder="⌕ имя, папка или месяц…" onInput={(e) => setQ(e.currentTarget.value)} />
          </PageHead>
          {shown.map((s) => {
            const name = nameOf(s.callsign ?? s.sid);
            const typed = del?.sid === s.sid ? del.typed : "";
            return (
              <div key={s.sid} className="pt-row" data-sid={s.sid}>
                <span>
                  <b>{name}</b>
                  {` ${s.dir ?? ""} · последняя точка ${day(s.head.at)}`}
                </span>
                <Opts>
                  <Btn
                    bad
                    onClick={() => {
                      setDel({ sid: s.sid, name, typed: "" });
                      setDone("");
                    }}
                  >
                    Удалить…
                  </Btn>
                  {ms.length ? <Btn onClick={() => void openMove(s)}>Перенести на машину…</Btn> : null}
                </Opts>
                {del?.sid === s.sid ? (
                  <Sec dlg data-dlg="delete">
                    <b>{`Удалить точки «${name}» насовсем`}</b>
                    <Note>Строки точек и блоки без ссылок уйдут из R2 сразу, в том же запросе; блоки, нужные копиям, останутся. Отменить нельзя — отмены у удаления нет.</Note>
                    <Opts>
                      <span>{`Введите имя сессии: ${name}`}</span>
                      <In
                        mono
                        data-f={`del:${s.sid}`}
                        placeholder={name}
                        value={typed}
                        onChange={() => {}}
                        onInput={(e) => {
                          const v = e.currentTarget.value;
                          setDel((x) => x && { ...x, typed: v });
                        }}
                      />
                    </Opts>
                    <Opts>
                      <Btn onClick={() => setDel(null)}>Отмена</Btn>
                      <Btn bad data-act="delete" disabled={typed !== name} onClick={() => void remove(del)}>
                        Удалить насовсем
                      </Btn>
                    </Opts>
                  </Sec>
                ) : null}
                {move?.s.sid === s.sid ? moveView(move) : null}
              </div>
            );
          })}
          {done ? (
            <Sec tone="ok" role="status">
              <b>{done}</b>
              <Note>Запись — в «Журнале флота».</Note>
            </Sec>
          ) : null}
        </Sec>
        <Note>
          {`В R2 ${mb(fleet.r2.bytes)}`}
          {fleet.sweep ? ` · уборка ${day(fleet.sweep.at)} ${hhmm(fleet.sweep.at)} — удалено ${fleet.sweep.blocks} блоков, ${mb(fleet.sweep.bytes)}` : ""}
        </Note>
      </Page>
    );
  }

  // ───── вкладка «Точки» сессии ─────
  function SessionPoints({ params }: ScreenProps) {
    const callsign = params.callsign ?? "";
    const machine = machineOf(callsign) ?? "";
    app.use(() => rev);
    const roster = app.use(() => app.roster());
    const [note, setNote] = useState<{ text: string; tone?: "ok" | "bad" }>({ text: "" });
    const [picked, setPicked] = useState<number | null>(null);
    const [unmark, setUnmark] = useState<string | null>(null);
    const [dlg, setDlg] = useState<Dlg | null>(null);
    /** слово отказа реестра: линии (points.list) или первых слов (points.get) */
    const [refused, setRefused] = useState("");
    /** сессия в реестре: шаги диалога читают её и после ожидания ответа */
    const sid = useRef("");
    /** номер открытого окна: новое окно — новые поля ввода */
    const opened = useRef(0);

    const session = () => app.roster()?.sessions.find((s) => s.callsign === callsign);
    const line = () => (sid.current ? lines.get(sid.current) : undefined);
    const dirOf = () => line()?.points.find((p) => p.id === line()?.head)?.dir ?? fleet?.sessions.find((s) => s.sid === sid.current)?.dir ?? "~";

    async function load() {
      if (!fleet?.sessions.some((s) => s.callsign === callsign)) await loadFleet();
      sid.current = fleet?.sessions.find((s) => s.callsign === callsign)?.sid ?? "";
      if (!sid.current) return changed();
      const r = await app.request<Line>("points.list", { sid: sid.current });
      if (r.ok) lines.set(sid.current, r.result);
      let word = r.ok ? "" : `points.list: ${r.error}`;
      // первые слова — поле last точек на экране; машина для этого не нужна
      const ids = (r.ok ? r.result.points : []).slice(0, 12).map((p) => p.id).filter((id) => !full.has(id));
      if (ids.length) {
        const g = await app.request<{ points: Full[] }>("points.get", { ids });
        if (g.ok) for (const p of g.result.points) full.set(p.id, p);
        else word = `points.get: ${g.error}`;
      }
      setRefused(word);
      changed();
    }

    // пометку поставили (roster принёс r2) — загрузить линию; на открытой вкладке — сразу
    const inR2 = !!r2Of(roster?.sessions.find((s) => s.callsign === callsign));
    useEffect(() => {
      if (inR2) void load();
    }, [inR2]);

    async function mark(on: boolean) {
      setNote({ text: on ? "Включаю…" : "Удаляю точки…" });
      const r = await app.request<{ point?: number; deleted?: number }>("session.r2", { callsign, on });
      if (!r.ok) return setNote({ text: say(r.error, callsign), tone: "bad" });
      if (on) return setNote({ text: `Первая точка — №${r.result.point}, только что; дальше Host кладёт их сам.`, tone: "ok" });
      setUnmark(null);
      if (sid.current) lines.delete(sid.current);
      sid.current = "";
      setNote({ text: `${r.result.deleted ?? 0} ${plural(r.result.deleted ?? 0, "точка удалена", "точки удалено", "точек удалено")} из R2 — сразу, без отмены. Сессия на ${machine} работает дальше, без точек.`, tone: "ok" });
    }

    async function saveNow() {
      setNote({ text: "Сохраняю точку…" });
      const r = await app.request<{ point: number; same: boolean }>("points.save", { callsign });
      setNote(r.ok ? { text: `Точка №${r.result.point}${r.result.same ? " — та же, файлы не менялись" : ""}`, tone: "ok" } : { text: say(r.error, callsign), tone: "bad" });
      if (r.ok) await load();
    }

    async function open(kind: Dlg["kind"], from: "fresh" | number = "fresh") {
      const name = nameOf(callsign);
      const target = kind === "dir" || kind === "rb" ? machine : (raisers().find((m) => m !== machine) ?? machine);
      const d: Dlg = {
        kind,
        target,
        from,
        slot: "",
        slots: null,
        dir: kind === "copy" ? `${dirOf()}-copy` : kind === "dir" ? `${dirOf()}-v2` : dirOf(),
        name: kind === "copy" ? `${name}-copy` : kind === "dir" ? `${name}-v2` : name,
        files: kind === "dir" || kind === "rb" ? "keep" : "point",
        interrupt: false,
        check: null,
        phase: "",
        msg: "",
      };
      opened.current++;
      setDlg(d);
      if (kind === "move" || kind === "copy") await target_(d, target);
    }
    async function target_(d: Dlg, m: string) {
      setDlg((x) => x && { ...x, target: m });
      const sl = await slotsOf(m);
      if (!Array.isArray(sl)) return setDlg((x) => x && { ...x, slots: null, check: sl });
      const cur = String((session()?.slot as { name?: string } | undefined)?.name);
      const slot = sl.includes(cur) ? cur : (sl[0] ?? "");
      setDlg((x) => x && { ...x, slots: sl, slot });
      await check({ ...d, target: m, slots: sl, slot });
    }
    async function check(d: Dlg) {
      // слоты цели не пришли — проверка остаётся отказом, подъём недоступен
      if ((d.kind !== "move" && d.kind !== "copy") || d.slots === null) return;
      const head = line()?.head;
      const point = d.from === "fresh" ? head : d.from;
      const c = typeof point === "number" ? await dry(d.target, sid.current, point, d.dir) : { error: "bad_point" };
      setDlg((x) => x && { ...x, check: c });
    }

    /** Шаги диалога: точка (со стопом, кроме копии), затем подъём; смена папки — ещё «Забыть» прежнюю. */
    async function run(d: Dlg) {
      const step = (msg: string) => setDlg((x) => x && { ...x, phase: "run", msg });
      const fail = (w: string) => setDlg((x) => x && { ...x, phase: "err", msg: d.kind === "dir" && w === "open_failed" ? `Копия не поднялась — «Забыть» не отправлен, ${callsign} остаётся остановленной` : say(w, nameOf(callsign), d.target, machine) });
      let point = typeof d.from === "number" ? d.from : 0;
      const stop = d.kind !== "copy";
      if (stop || d.from === "fresh") {
        step(stop ? `${machine} дожидается конца ответа, останавливает сессию и кладёт точку…` : `${machine} кладёт свежую точку…`);
        const s = await app.request<{ point: number; same: boolean }>("points.save", { callsign, ...(stop ? { stop: true } : {}), ...(d.interrupt ? { interrupt: true } : {}) });
        if (!s.ok) return fail(s.error);
        if (d.from === "fresh") point = s.result.point;
      }
      step(`${d.target} поднимает сессию из точки №${point}…`);
      const body: Record<string, unknown> = { machine: d.target, sid: sid.current, point, dir: d.dir, files: d.files };
      if (d.kind === "copy" || d.kind === "dir") Object.assign(body, { copy: true, name: d.name });
      if (d.slot && (d.kind === "move" || d.kind === "copy")) body.slot = d.slot;
      const r = await app.request<{ callsign: string; point: number; folder: string; branch: string | null }>("points.raise", body);
      if (!r.ok) return fail(r.error);
      keepProject(callsign, r.result.callsign);
      if (d.kind === "dir") {
        step(`«Забыть» ${callsign}…`);
        const rm = await app.request("session.remove", { callsign });
        if (!rm.ok) return fail(rm.error);
      }
      const msg =
        d.kind === "move"
          ? `${nameOf(callsign)} перенесена на ${d.target}: ${r.result.callsign}. ${machine} её отпустил.`
          : d.kind === "copy"
            ? `Копия поднята: ${r.result.callsign}. Исходная сессия не менялась.`
            : d.kind === "dir"
              ? `Копия в новой папке: ${r.result.callsign}; ${callsign} забыта, её точки остались в R2.`
              : `Откат: ${callsign} поднята из точки №${point}; нынешнее — веткой «до отката»${r.result.branch ? `, папка на ветке git ${r.result.branch}` : ""}. Новая ссылка claude.ai придёт в roster.`;
      setDlg((x) => x && { ...x, phase: "done", msg });
      void load();
    }

    function dlgView(d: Dlg) {
      const titles = { move: `Перенести ${callsign}`, copy: `Скопировать ${callsign}`, dir: `Сменить папку ${callsign}`, rb: `Откатить ${callsign} к ${typeof d.from === "number" ? `точке №${d.from}` : "точке"}` };
      const busy = d.phase === "run";
      const moving = d.kind === "move" || d.kind === "copy";
      const blocked = moving && (!d.check || "error" in d.check || d.check.folder === "other");
      const head = line()?.head;
      const label = { move: `Перенести на ${d.target}`, copy: `Скопировать на ${d.target}`, dir: "Скопировать и забыть", rb: `Откатить к ${typeof d.from === "number" ? `№${d.from}` : "точке"}` }[d.kind];
      return (
        <Sec key={opened.current} dlg data-dlg={d.kind}>
          <H4>{titles[d.kind]}</H4>
          {moving ? (
            <Row label="Машина">
              <Opts>
                {raisers().map((m) => (
                  <Btn key={m} aria-pressed={m === d.target ? "true" : "false"} disabled={busy} onClick={() => void target_(d, m)}>
                    {m}
                  </Btn>
                ))}
              </Opts>
            </Row>
          ) : (
            <Row label="Машина">
              <span>{`${machine} — та же`}</span>
            </Row>
          )}
          {moving ? (
            <Row label="Из точки">
              <Opts>
                <Btn
                  aria-pressed={d.from === "fresh" ? "true" : "false"}
                  onClick={() => {
                    setDlg((x) => x && { ...x, from: "fresh" });
                    void check({ ...d, from: "fresh" });
                  }}
                >
                  сейчас — сохранится свежая
                </Btn>
                {typeof d.from === "number" ? <Btn aria-pressed="true">{`№${d.from}`}</Btn> : null}
              </Opts>
            </Row>
          ) : null}
          {moving && d.slots ? (
            <Row label={`Слот на ${d.target}`}>
              <Opts>
                {[...d.slots, ""].map((x) => (
                  <Btn key={x} aria-pressed={d.slot === x ? "true" : "false"} onClick={() => setDlg((y) => y && { ...y, slot: x })}>
                    {x || "без слота"}
                  </Btn>
                ))}
              </Opts>
            </Row>
          ) : null}
          {d.kind !== "rb" ? (
            <Row label={d.kind === "dir" ? "Новая папка" : `Папка на ${d.target}`}>
              <DirInput
                value={d.dir}
                onInput={(dir) => setDlg((x) => x && { ...x, dir })}
                onCommit={(dir) => {
                  setDlg((x) => x && { ...x, dir });
                  void check({ ...d, dir });
                }}
              />
            </Row>
          ) : (
            <Row label="Папка">
              <M>{dirOf()}</M>
            </Row>
          )}
          {d.kind === "copy" || d.kind === "dir" ? (
            <Row label={d.kind === "copy" ? "Имя копии" : "Имя"}>
              <Opts>
                <In
                  mono
                  data-f="name"
                  defaultValue={d.name}
                  onInput={(e) => {
                    const name = e.currentTarget.value;
                    setDlg((x) => x && { ...x, name });
                  }}
                />
                <Note>{`→ ${d.name}@${d.target}`}</Note>
              </Opts>
            </Row>
          ) : null}
          <CheckLine d={d} />
          {d.kind === "dir" ? <Note>папка — как есть: правки точки не применяются. Папку живой сессии не меняют: claude держит её с запуска. Не поднялась копия — «Забыть» не шлётся.</Note> : null}
          {d.kind === "rb" ? (
            <Opts>
              <Btn aria-pressed={d.files === "keep" ? "true" : "false"} onClick={() => setDlg((x) => x && { ...x, files: "keep" })}>
                Оставить как есть
              </Btn>
              <Btn aria-pressed={d.files === "point" ? "true" : "false"} onClick={() => setDlg((x) => x && { ...x, files: "point" })}>
                Вернуть к папке точки
              </Btn>
            </Opts>
          ) : null}
          {d.kind === "rb" ? <Note>Нынешнее сначала сохранится веткой «до отката» — из неё можно скопировать или продолжить ею.</Note> : null}
          {d.kind === "rb" && (session()?.remote as { url?: string } | undefined)?.url ? (
            <Sec tone="wait" data-remote="">
              <b>Привязка к claude.ai снимется</b>
              <Note>После отката в claude.ai — новая сессия без прежней истории, кнопка «В claude.ai» поведёт на неё. Прежняя сессия в claude.ai останется как была.</Note>
            </Sec>
          ) : null}
          {d.kind !== "copy" ? (
            <OptsLabel>
              <input
                type="checkbox"
                checked={d.interrupt}
                onChange={(e) => {
                  const interrupt = e.currentTarget.checked;
                  setDlg((x) => x && { ...x, interrupt });
                }}
              />
              {d.kind === "rb" ? "прервать идущий ответ и откатить сразу (иначе — после конца ответа)" : "прервать ответ и сделать сразу"}
            </OptsLabel>
          ) : null}
          {d.kind === "move" ? <Note>{`Сначала ${machine} остановит сессию и снимет точку, потом ${d.target} поднимет её. Сорвётся подъём — сессия снова пойдёт на ${machine}.`}</Note> : null}
          {d.kind === "copy" ? <Note>Исходная сессия не меняется. У копии своё имя и своя сессия в claude.ai.</Note> : null}
          {d.msg ? (
            <Note tone={d.phase === "err" ? "bad" : d.phase === "done" ? "ok" : "wait"} role="status" data-phase={d.phase}>
              {d.msg}
            </Note>
          ) : null}
          <Opts>
            <Btn onClick={() => setDlg(null)}>{d.phase === "done" ? "Закрыть" : "Отмена"}</Btn>
            {d.phase !== "done" ? (
              <Btn pri data-act="run" disabled={busy || blocked || typeof head !== "number"} onClick={() => void run(d)}>
                {label}
              </Btn>
            ) : null}
          </Opts>
        </Sec>
      );
    }

    function pointCard(p: LPoint, ln: Line) {
      const last = (full.get(p.id)?.last ?? []) as unknown[][];
      return (
        <Sec data-card={p.id}>
          <Row label="когда">
            <span>{`${day(p.at)} ${hhmm(p.at)} · №${p.id}${p.id === ln.head ? " · последняя" : ""}`}</span>
          </Row>
          <Row label="почему">
            <span>{p.why}</span>
          </Row>
          {p.msgs !== undefined ? (
            <Row label="разговор">
              <span>{`${p.msgs} ${plural(p.msgs, "сообщение", "сообщения", "сообщений")}`}</span>
            </Row>
          ) : null}
          <Row label="с машины">
            <span>{p.machine}</span>
          </Row>
          {p.git ? (
            <Row label="папка">
              <span>{`git: ${p.git.state === "dirty" ? `${p.git.files} файла не закоммичено` : "чисто"}${p.git.branch ? ` · ${p.git.branch}` : ""}`}</span>
            </Row>
          ) : null}
          <Row label="срок">
            <span>{p.until ? `хранится до ${day(p.until)} ${new Date(p.until).getFullYear()}` : "хранится, пока есть сессия"}</span>
          </Row>
          {last.length ? <Note>{last.map((x) => x.filter((y) => typeof y === "string").join(" → ")).join(" · ")}</Note> : null}
          <Opts>
            {raisers().length ? <Btn onClick={() => void open("copy", p.id)}>Скопировать из этой точки…</Btn> : null}
            {p.id !== ln.head && app.can(machine, "points.raise") ? (
              <Btn data-act="rb" onClick={() => void open("rb", p.id)}>
                Откатить к этой точке…
              </Btn>
            ) : null}
          </Opts>
        </Sec>
      );
    }

    const s = session();
    const r2 = r2Of(s);
    const noteEl = note.text ? (
      <Note tone={note.tone} role="status" data-note="">
        {note.text}
      </Note>
    ) : null;
    if (!r2) {
      return (
        <Page>
          <Sec data-r2="off">
            <b>{`${callsign} не в R2`}</b>
            <Note>Точек нет: перенос, копия, откат, смена папки и «пожар» — только у сессий в R2.</Note>
            {app.can(machine, "session.r2") ? (
              <OptsLabel>
                <input type="checkbox" data-act="r2" checked={false} onChange={() => void mark(true)} />
                Хранить в R2
              </OptsLabel>
            ) : null}
            <Note>Включите — Host сразу положит первую точку.</Note>
            {noteEl}
          </Sec>
        </Page>
      );
    }
    const ln = line();
    const head = ln?.points.find((p) => p.id === ln.head);
    const name = nameOf(callsign);
    const has = raisers().length > 0;
    let lastDay = "";
    return (
      <Page>
        <Sec data-r2="on">
          <PageHead>
            <b>{head ? `Точка ${ago(head.at)} · №${head.id}${head.bytes ? ` · ${(head.bytes / 1048576).toFixed(1).replace(".", ",")} МБ` : ""}` : refused || (sid.current ? "…" : "Точек ещё нет")}</b>
            {app.can(machine, "points.save") ? <Btn onClick={() => void saveNow()}>Сохранить точку</Btn> : null}
            {app.can(machine, "points.raise") || has ? (
              <Btn disabled={!head} onClick={() => void open("move")}>
                Перенести…
              </Btn>
            ) : null}
            {has ? (
              <Btn disabled={!head} onClick={() => void open("copy")}>
                Скопировать…
              </Btn>
            ) : null}
            {app.can(machine, "points.raise") ? (
              <Btn disabled={!head} data-act="dir" onClick={() => void open("dir")}>
                Сменить папку…
              </Btn>
            ) : null}
          </PageHead>
          <Note>сохраняются сами: в разговоре новое и ответ кончился — Host кладёт точку сам</Note>
          {r2.error ? <Note tone="bad">{`последняя точка не удалась: ${r2.error}`}</Note> : null}
          {refused && head ? (
            <Note tone="bad" role="alert">
              {refused}
            </Note>
          ) : null}
          {noteEl}
        </Sec>
        {dlg ? dlgView(dlg) : null}
        {ln ? (
          <Sec data-points="">
            <H4>Линия и ветки</H4>
            {[...ln.points]
              .sort((a, b) => b.at - a.at)
              .map((p) => {
                const d = day(p.at);
                const newDay = d !== lastDay;
                lastDay = d;
                const last = full.get(p.id)?.last?.[0] as unknown[] | undefined;
                const words = typeof last?.[0] === "string" ? `«${last[0]}»` : p.why;
                return (
                  <Fragment key={p.id}>
                    {newDay ? <div className="pt-day">{d}</div> : null}
                    <button className={"pt-pt" + (p.line ? "" : " br")} aria-pressed={picked === p.id ? "true" : "false"} data-point={p.id} onClick={() => setPicked(picked === p.id ? null : p.id)}>
                      <span>{hhmm(p.at)}</span>
                      <i />
                      <span>{words}</span>
                      <em>{p.line ? `№${p.id}` : `ветка · №${p.id}`}</em>
                    </button>
                    {picked === p.id ? pointCard(p, ln) : null}
                  </Fragment>
                );
              })}
          </Sec>
        ) : null}
        <Sec>
          <OptsLabel>
            <input type="checkbox" checked={unmark === null} data-act="r2" onChange={() => setUnmark(unmark === null ? "" : null)} />
            Хранить в R2
          </OptsLabel>
          <Note>Снять — точки сессии удалятся из R2 сразу, без отмены.</Note>
          {unmark !== null ? (
            <Sec dlg data-dlg="unmark">
              <b>{`Убрать ${callsign} из R2`}</b>
              <Note>{`Точки и ветки сессии удалятся из R2 сразу; отменить нельзя. Сессия на ${machine} продолжит работу — без точек и переноса.`}</Note>
              <Opts>
                <span>{`Введите имя сессии: ${name}`}</span>
                <In mono data-f="unmark" placeholder={name} onInput={(e) => setUnmark(e.currentTarget.value)} />
              </Opts>
              <Opts>
                <Btn onClick={() => setUnmark(null)}>Отмена</Btn>
                <Btn bad data-act="unmark" disabled={unmark !== name} onClick={() => void mark(false)}>
                  Убрать из R2
                </Btn>
              </Opts>
            </Sec>
          ) : null}
        </Sec>
      </Page>
    );
  }

  const fireCount = () => {
    const on = online();
    return (fleet?.sessions ?? []).filter((s) => !on.has(s.owner)).length;
  };

  const mod: AppModule = {
    screens: {
      points: { nav: "Точки", group: "Флот", label: "Точки", view: Overview, head: () => ({ title: "Точки" }) },
      "session.points": {
        place: "card.tab",
        label: "Точки",
        path: "session-points",
        // вкладка видна, когда машина сессии умеет точки
        show: (p) => app.can(machineOf(p.callsign ?? "") ?? "", "session.r2") === true,
        view: SessionPoints,
      },
    },
    marks: { fire: fireCount },
    css,
    start(a) {
      app = a;
    },
  };
  return mod;
}
