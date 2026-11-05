// Экран «Точки»: обзор реестра, «только в R2» с удалением и подъёмом, «пожар» — перенос сессий ушедшей машины.
import { nameOf } from "@switchboard/protocol";
import { Fragment, useEffect, useRef, useState } from "react";
import { ago, Btn, day, H4, hhmm, In, M, machinesWith, Note, Opts, Outcome, type OutcomeNote, Page, PageHead, plural, Row, Sec, sessionLabel, useApp, useModule } from "@switchboard/web-ui";
import type { Listed, PointsStore } from "./store.ts";
import { CheckLine, MachineRow, PENDING, runnable, SlotRow, useProbe, useTarget } from "./target.tsx";
import { type Check, folderCheck, mb, type Probe, points, wordText } from "./words.ts";

const nameIn = (x: Listed) => (x.callsign ? nameOf(x.callsign) : x.sid);
const others = (owner: string) => (all: string[]) => all.find((m) => m !== owner) ?? all[0] ?? "";

/** Новая сессия встаёт в проект исходной. */
function useAssign() {
  const app = useApp();
  return (source: string | undefined, callsign: string) => {
    const project = source ? (app.mark("project.of", source) as { id: string } | null | undefined) : null;
    if (project && source !== callsign) app.run("board.assign", { callsign, project: project.id });
  };
}

function RaiseDialog({ x, close }: { x: Listed; close(): void }) {
  const app = useApp();
  const store = useModule<PointsStore>();
  const assign = useAssign();
  const name = nameIn(x);
  const dir = x.dir ?? "~";
  const t = useTarget(others(x.owner));
  const check = useProbe(t, { sid: x.sid, point: x.head.id, dir });
  const [note, setNote] = useState<OutcomeNote | null>(null);
  const [state, setState] = useState<"" | "run" | "done">("");

  async function go(): Promise<void> {
    setState("run");
    setNote({ text: `${t.machine} поднимает сессию из точки…` });
    const r = await app.request<{ callsign: string }>("points.raise", { machine: t.machine, sid: x.sid, point: x.head.id, dir, files: "point", ...(t.slot ? { slot: t.slot } : {}) });
    if (!r.ok) {
      setState("");
      setNote({ text: r.error === "open_failed" ? `Не поднялась на ${t.machine}` : wordText(r.error, { name, target: t.machine }), tone: "bad" });
      return;
    }
    setState("done");
    setNote({ text: `${name} поднята: ${r.result.callsign}`, tone: "ok" });
    assign(x.callsign, r.result.callsign);
    void store.read();
  }

  return (
    <Sec dlg data-dlg="raise">
      <b>{`Поднять ${name} из точки №${x.head.id}`}</b>
      <MachineRow label="Машина" t={t} />
      <SlotRow t={t} check={check} />
      <Row label="Папка">
        <M>{dir}</M>
      </Row>
      <CheckLine check={check} />
      <Outcome note={note} />
      <Opts>
        <Btn onClick={close}>{state === "done" ? "Закрыть" : "Отмена"}</Btn>
        {state === "done" ? null : (
          <Btn pri disabled={state === "run" || !runnable(check)} onClick={() => void go()}>
            {`Поднять на ${t.machine}`}
          </Btn>
        )}
      </Opts>
    </Sec>
  );
}

function DeleteDialog({ x, close, done }: { x: Listed; close(): void; done(note: OutcomeNote): void }) {
  const app = useApp();
  const store = useModule<PointsStore>();
  const name = nameIn(x);
  const [typed, setTyped] = useState("");

  async function go(): Promise<void> {
    const r = await app.request<{ points: number }>("points.delete", { sid: x.sid });
    if (!r.ok) return done({ text: `points.delete: ${r.error}`, tone: "bad" });
    done({ text: `${name} удалена — ${points(r.result.points)}`, tone: "ok" });
    close();
    await store.read();
  }

  return (
    <Sec dlg data-dlg="delete">
      <b>{`Удалить точки «${name}» насовсем`}</b>
      <Note>Строки точек и блоки без ссылок уйдут из R2 сразу, в том же запросе; блоки, нужные копиям, останутся. Отменить нельзя — отмены у удаления нет.</Note>
      <Opts>
        <span>{`Введите имя сессии: ${name}`}</span>
        <In mono data-f={`del:${x.sid}`} placeholder={name} value={typed} onInput={(e) => setTyped(e.currentTarget.value)} />
      </Opts>
      <Opts>
        <Btn onClick={close}>Отмена</Btn>
        <Btn bad data-act="delete" disabled={typed !== name} onClick={() => void go()}>
          Удалить насовсем
        </Btn>
      </Opts>
    </Sec>
  );
}

function OnlySection({ rows }: { rows: Listed[] }) {
  const app = useApp();
  const canRaise = app.use(() => machinesWith(app, "points.raise").length > 0);
  const [q, setQ] = useState("");
  const [note, setNote] = useState<OutcomeNote | null>(null);
  /** открытое окно строки; номер — повторное «Удалить…» начинает окно заново */
  const [open, setOpen] = useState<{ sid: string; kind: "delete" | "raise"; n: number } | null>(null);
  const needle = q.trim().toLowerCase();
  const month = (t: number) => new Date(t).toLocaleDateString("ru-RU", { month: "long" });
  const shown = [...rows].sort((a, b) => b.head.at - a.head.at).filter((x) => !needle || [nameIn(x), x.dir ?? "", day(x.head.at), month(x.head.at)].some((s) => s.toLowerCase().includes(needle)));
  return (
    <Sec data-only="">
      <PageHead>
        <H4>{`Только в R2 · ${rows.length}`}</H4>
        <In data-f="q" size={26} placeholder="⌕ имя, папка или месяц…" value={q} onInput={(e) => setQ(e.currentTarget.value)} />
      </PageHead>
      {shown.map((x) => (
        <div key={x.sid} className="pt-row" data-sid={x.sid}>
          <span>
            <b>{nameIn(x)}</b>
            {` ${x.dir ?? "~"} · последняя точка ${day(x.head.at)}`}
          </span>
          <Opts>
            <Btn bad onClick={() => setOpen({ sid: x.sid, kind: "delete", n: (open?.n ?? 0) + 1 })}>
              Удалить…
            </Btn>
            {canRaise ? <Btn onClick={() => setOpen({ sid: x.sid, kind: "raise", n: (open?.n ?? 0) + 1 })}>Перенести на машину…</Btn> : null}
          </Opts>
          {open?.sid === x.sid && open.kind === "delete" ? <DeleteDialog key={open.n} x={x} close={() => setOpen(null)} done={setNote} /> : null}
          {open?.sid === x.sid && open.kind === "raise" ? <RaiseDialog key={open.n} x={x} close={() => setOpen(null)} /> : null}
        </div>
      ))}
      <Outcome note={note} />
    </Sec>
  );
}

/** Проверки папок всех сессий на машине цели. */
function useFireChecks(rows: Listed[], machine: string, ready: boolean) {
  const app = useApp();
  const [checks, setChecks] = useState<Record<string, Check>>({});
  useEffect(() => {
    if (!ready) return;
    let gone = false;
    setChecks({});
    for (const x of rows) {
      void app.read<Probe>("points.raise", { machine, sid: x.sid, point: x.head.id, dir: x.dir ?? "~", files: "point", dryRun: true }).then((r) => {
        if (gone) return;
        setChecks((c) => ({ ...c, [x.sid]: r.ok ? folderCheck(r.result, machine) : { key: "error", text: wordText(r.error), tone: "bad" } }));
      });
    }
    return () => {
      gone = true;
    };
    // пробы заново — только другая машина: строки те же, пока окно открыто
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [machine, ready]);
  return checks;
}

function FireDialog({ machine: from, rows, close }: { machine: string; rows: Listed[]; close(): void }) {
  const app = useApp();
  const store = useModule<PointsStore>();
  const assign = useAssign();
  const t = useTarget((all) => all[0] ?? "");
  const checks = useFireChecks(rows, t.machine, t.ready);
  const [running, setRunning] = useState(false);
  const [line, setLine] = useState<Record<string, string>>({});
  const [done, setDone] = useState(0);
  const [over, setOver] = useState(false);
  const closed = useRef(false);
  useEffect(
    () => () => {
      closed.current = true;
    },
    [],
  );

  async function go(): Promise<void> {
    setRunning(true);
    store.moving(true);
    let ready = 0;
    for (const x of rows) {
      if (closed.current) break;
      setLine((l) => ({ ...l, [x.sid]: "поднимается…" }));
      const r = await app.request<{ callsign: string }>("points.raise", { machine: t.machine, sid: x.sid, point: x.head.id, dir: x.dir ?? "~", files: "point", ...(t.slot ? { slot: t.slot } : {}) });
      if (r.ok) {
        ready++;
        setDone(ready);
        assign(x.callsign, r.result.callsign);
      }
      setLine((l) => ({ ...l, [x.sid]: r.ok ? `готова — ${r.result.callsign}` : `не поднялась: ${wordText(r.error)}` }));
    }
    setOver(true);
    store.moving(false);
    void store.read();
  }

  const n = rows.length;
  const allFine = rows.every((x) => checks[x.sid] && runnable(checks[x.sid])) && t.ready;
  return (
    <Sec dlg data-dlg="fire">
      <H4>{`Перенести сессии ${from} на другую машину`}</H4>
      {running ? (
        <Sec role="status" tone={over && done === n ? "ok" : "wait"} data-progress={`${done}/${n}`}>
          <b>{`Перенос с ${from} на ${t.machine}: ${done} из ${n} готовы${over ? "" : " — не закрывайте страницу"}`}</b>
        </Sec>
      ) : (
        <>
          <MachineRow label="Куда" t={t} />
          <SlotRow t={t} label={`Слот на ${t.machine}`} />
        </>
      )}
      {rows.map((x) => (
        <Sec key={x.sid} data-row={nameIn(x)}>
          <b>{nameIn(x)}</b>
          <Note>{`точка ${hhmm(x.head.at)} · №${x.head.id}`}</Note>
          {running ? (
            <Note>{line[x.sid] ?? ""}</Note>
          ) : (
            <>
              <Opts>
                <M>{x.dir ?? "~"}</M>
              </Opts>
              <Note>{t.slotsError ? `machine.accounts: ${t.slotsError}` : (checks[x.sid] ?? PENDING).text}</Note>
            </>
          )}
        </Sec>
      ))}
      <Opts>
        <Btn
          onClick={() => {
            closed.current = true;
            close();
          }}
        >
          {running ? "Закрыть" : "Отмена"}
        </Btn>
        {running ? null : (
          <Btn pri disabled={!allFine} onClick={() => void go()}>
            {`Перенести ${n} из ${n} на ${t.machine}`}
          </Btn>
        )}
      </Opts>
    </Sec>
  );
}

function FireBar({ machine, rows, open, setOpen }: { machine: string; rows: Listed[]; open: boolean; setOpen(on: boolean): void }) {
  const app = useApp();
  const store = useModule<PointsStore>();
  const left = app.use(() => app.mark("machines.left", machine) as number | undefined);
  const canMove = app.use(() => machinesWith(app, "points.raise").length > 0 && !store.get().moving);
  const n = rows.length;
  return (
    <Fragment>
      <Sec tone="bad" data-fire={machine}>
        <b>{`${machine} не на связи${left ? ` с ${hhmm(left)}` : ""} · ${n} ${plural(n, "сессия ждёт", "сессии ждут", "сессий ждут")} на последних точках`}</b>
        {canMove && !open ? (
          <Opts>
            <Btn pri onClick={() => setOpen(true)}>
              Перенести на другую машину…
            </Btn>
          </Opts>
        ) : null}
      </Sec>
      {open ? <FireDialog machine={machine} rows={rows} close={() => setOpen(false)} /> : null}
    </Fragment>
  );
}

function Live({ x }: { x: Listed }) {
  const app = useApp();
  const callsign = x.callsign ?? "";
  const label = app.use(() => sessionLabel(app, callsign).text);
  const canSave = app.use(() => app.can(x.owner, "points.save") === true);
  const store = useModule<PointsStore>();

  async function save(): Promise<void> {
    const r = await app.request<{ point: number; same?: boolean }>("points.save", { callsign });
    if (r.ok) app.toast(`${callsign}: точка №${r.result.point}${r.result.same ? " — та же" : ""}`, "ok");
    else app.toast(`${callsign}: ${wordText(r.error, { name: callsign })}`, "bad");
    await store.read();
  }

  return (
    <div className="pt-row" data-sid={x.sid}>
      <span>
        <b>{label}</b>
        {` ${ago(x.head.at)} · №${x.head.id}`}
      </span>
      {canSave ? <Btn onClick={() => void save()}>Сохранить сейчас</Btn> : null}
    </div>
  );
}

export function Overview() {
  const app = useApp();
  const store = useModule<PointsStore>();
  const fleet = app.use(() => store.get().fleet);
  const error = app.use(() => store.get().error);
  const fire = app.use(() => store.fire());
  const [fireOpen, setFireOpen] = useState("");
  const records = app.use(() => (app.roster()?.sessions ?? []).map((s) => ({ callsign: s.callsign, r2: s.r2 !== undefined })));
  const order = app.use(() => (app.roster()?.machines ?? []).map((m) => m.machine));

  useEffect(() => void store.read(), [store]);
  useEffect(() => {
    for (const machine of fire) app.run("machines.left.read", { machine });
    // спрашиваем об ушедшей машине один раз: список меняется редко
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fire.join()]);

  if (!fleet) {
    return (
      <Page>
        <PageHead title="Точки" />
        {error ? <Note role="alert" tone="bad">{`points.list: ${error}`}</Note> : <Note>…</Note>}
      </Page>
    );
  }

  const inRoster = new Set(records.map((r) => r.callsign));
  const atFire = (m: string) => fleet.sessions.filter((x) => x.owner === m);
  const online = fleet.sessions.filter((x) => !fire.includes(x.owner));
  const live = online.filter((x) => x.callsign && inRoster.has(x.callsign)).sort((a, b) => a.head.at - b.head.at);
  const only = online.filter((x) => !x.callsign || !inRoster.has(x.callsign));
  const machineRank = (cs: string) => order.indexOf(cs.split("@")[1] ?? "");
  const notIn = records.filter((r) => !r.r2).map((r) => r.callsign).sort((a, b) => machineRank(a) - machineRank(b));
  const sweep = fleet.sweep;

  return (
    <Page>
      <PageHead title="Точки" />
      {error ? <Note role="alert" tone="bad">{`points.list: ${error}`}</Note> : null}
      {fire.map((m) => (
        <FireBar key={m} machine={m} rows={atFire(m)} open={fireOpen === m} setOpen={(on) => setFireOpen(on ? m : "")} />
      ))}
      <Opts data-summary="">
        <b>{`${live.length} ${plural(live.length, "сессия", "сессии", "сессий")} в R2 из ${records.length} на машинах`}</b>
        {fire.map((m) => (
          <Note key={m} tone="bad">{`· ${atFire(m).length} на ${m} — нет связи`}</Note>
        ))}
        <Note>{`· ${only.length} только в R2`}</Note>
      </Opts>
      <Sec>
        <H4>Последняя точка</H4>
        {live.length ? live.map((x) => <Live key={x.sid} x={x} />) : <Note>Сессий в R2 на связи нет.</Note>}
      </Sec>
      {notIn.length ? <Note>{`${notIn.join(", ")} не в R2`}</Note> : null}
      <OnlySection rows={only} />
      <Note>
        {`В R2 ${mb(fleet.r2.bytes)} МБ`}
        {sweep ? ` · уборка ${day(sweep.at)} ${hhmm(sweep.at)} — удалено ${sweep.blocks} ${plural(sweep.blocks, "блок", "блока", "блоков")}, ${mb(sweep.bytes)} МБ` : ""}
      </Note>
    </Page>
  );
}
