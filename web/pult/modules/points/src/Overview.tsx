// Экран «Точки»: сессии в R2, «только в R2», «пожар» — машины, которых нет в roster, и объём.
import { Fragment, useEffect, useRef, useState } from "react";
import { ago, at, Btn, day, H4, In, M, Note, OkCard, Opts, Outcome, Page, PageHead, Row, Sec, sessionLabel, useApp, useModule, useOutcome } from "@switchboard/web-ui";
import type { Fleet, Listed } from "./store.ts";
import { joinProject, Machines, Slot, useProbe, useTarget, type Target } from "./target.tsx";
import { blocked, countOf, megabytes, refused, type Check } from "./words.ts";

const nameOf = (s: Listed) => (s.callsign ? s.callsign.split("@")[0] : s.sid.slice(0, 8));
const dirOf = (s: Listed) => s.dir ?? "~";
const probeOf = (s: Listed) => ({ sid: s.sid, point: s.head.id, dir: dirOf(s), files: "point" });
const raiseOf = (s: Listed, machine: string, slot: string) => ({ ...probeOf(s), machine, ...(slot ? { slot } : {}) });

/** Строка живой сессии в R2. */
function Live({ s, fleet }: { s: Listed; fleet: Fleet }) {
  const app = useApp();
  const callsign = s.callsign!;
  const save = async () => {
    const r = await app.request<{ point: number; same: boolean }>("points.save", { callsign });
    app.toast(`${callsign}: ${r.ok ? `точка №${r.result.point}${r.result.same ? " — та же" : ""}` : refused(r.error, { who: callsign })}`, r.ok ? "ok" : "bad");
    void fleet.read();
  };
  return (
    <div className="pt-row" data-sid={s.sid}>
      <span>
        <b>{sessionLabel(app, callsign).text}</b> {`${ago(s.head.at)} · №${s.head.id}`}
      </span>
      {app.can(s.owner, "points.save") ? <Btn onClick={() => void save()}>Сохранить сейчас</Btn> : null}
    </div>
  );
}

/** Окно подъёма сессии «только в R2». */
function RaiseWindow({ s, fleet, close }: { s: Listed; fleet: Fleet; close(): void }) {
  const app = useApp();
  const t = useTarget({ owner: s.owner });
  const check = useProbe(t.machine, t.slots && !t.problem ? probeOf(s) : null);
  const [note, setNote] = useState<{ text: string; tone?: "ok" | "bad" } | null>(null);
  const [going, setGoing] = useState(false);
  const done = note?.tone === "ok";
  const name = nameOf(s);
  const raise = async () => {
    setGoing(true);
    setNote({ text: `${t.machine} поднимает сессию из точки…` });
    const r = await app.request<{ callsign: string }>("points.raise", raiseOf(s, t.machine, t.slot));
    setGoing(false);
    if (!r.ok) return setNote({ text: refused(r.error, { target: t.machine }), tone: "bad" });
    setNote({ text: `${name} поднята: ${r.result.callsign}`, tone: "ok" });
    if (s.callsign) joinProject(app, s.callsign, r.result.callsign);
    void fleet.read();
  };
  return (
    <Sec dlg data-dlg="raise">
      <b>{`Поднять ${name} из точки №${s.head.id}`}</b>
      <Machines t={t} />
      <Row label="Папка">
        <M>{dirOf(s)}</M>
      </Row>
      <Slot t={t} />
      <CheckLine check={t.problem ? { key: "error", text: t.problem, tone: "bad" } : check} />
      <Outcome note={note} />
      <Opts>
        <Btn onClick={close}>{done ? "Закрыть" : "Отмена"}</Btn>
        {done ? null : (
          <Btn pri disabled={going || !!t.problem || blocked(check)} onClick={() => void raise()}>{`Поднять на ${t.machine}`}</Btn>
        )}
      </Opts>
    </Sec>
  );
}

export function CheckLine({ check }: { check: Check | null }) {
  return check ? (
    <Note data-check={check.key} tone={check.tone}>
      {check.text}
    </Note>
  ) : null;
}

/** Удаление «только в R2»: подтверждение именем. */
function DeleteWindow({ s, go, close }: { s: Listed; go(): void; close(): void }) {
  const [typed, setTyped] = useState("");
  const name = nameOf(s);
  return (
    <Sec dlg data-dlg="delete">
      <b>{`Удалить точки «${name}» насовсем`}</b>
      <Note>Строки точек и блоки без ссылок уйдут из R2 сразу, в том же запросе; блоки, нужные копиям, останутся. Отменить нельзя — отмены у удаления нет.</Note>
      <Opts>
        <span>{`Введите имя сессии: ${name}`}</span>
        <In mono data-f={`del:${s.sid}`} placeholder={name} value={typed} onInput={(e) => setTyped(e.currentTarget.value)} />
      </Opts>
      <Opts>
        <Btn onClick={close}>Отмена</Btn>
        <Btn bad data-act="delete" disabled={typed !== name} onClick={go}>
          Удалить насовсем
        </Btn>
      </Opts>
    </Sec>
  );
}

function Only({ sessions, fleet }: { sessions: Listed[]; fleet: Fleet }) {
  const app = useApp();
  const canRaise = app.use(() => (app.roster()?.machines ?? []).some((m) => app.can(m.machine, "points.raise")));
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<{ sid: string; kind: "raise" | "delete"; n: number } | null>(null);
  const [notes, say] = useOutcome();
  const needle = q.trim().toLowerCase();
  const shown = [...sessions].sort((a, b) => b.head.at - a.head.at).filter((s) => !needle || [nameOf(s), dirOf(s), day(s.head.at)].some((x) => x.toLowerCase().includes(needle)));
  const remove = async (s: Listed) => {
    const r = await app.request<{ points: number }>("points.delete", { sid: s.sid });
    setOpen(null);
    if (!r.ok) return say("delete", `points.delete: ${r.error}`, "bad");
    say("delete", `${nameOf(s)} удалена — ${countOf(r.result.points, "точка", "точки", "точек")}`, "ok");
    void fleet.read();
  };
  return (
    <Sec data-only="">
      <PageHead>
        <H4>{`Только в R2 · ${sessions.length}`}</H4>
        <In data-f="q" size={26} placeholder="⌕ имя, папка или месяц…" value={q} onInput={(e) => setQ(e.currentTarget.value)} />
      </PageHead>
      <Outcome note={notes.delete} />
      {shown.map((s) => (
        <Fragment key={s.sid}>
          <div className="pt-row" data-sid={s.sid}>
            <span>
              <b>{nameOf(s)}</b> {`${dirOf(s)} · последняя точка ${day(s.head.at)}`}
            </span>
            <Opts>
              <Btn bad onClick={() => setOpen({ sid: s.sid, kind: "delete", n: (open?.n ?? 0) + 1 })}>
                Удалить…
              </Btn>
              {canRaise ? <Btn onClick={() => setOpen({ sid: s.sid, kind: "raise", n: (open?.n ?? 0) + 1 })}>Перенести на машину…</Btn> : null}
            </Opts>
          </div>
          {open?.sid === s.sid && open.kind === "raise" ? <RaiseWindow key={open.n} s={s} fleet={fleet} close={() => setOpen(null)} /> : null}
          {open?.sid === s.sid && open.kind === "delete" ? <DeleteWindow key={open.n} s={s} go={() => void remove(s)} close={() => setOpen(null)} /> : null}
        </Fragment>
      ))}
    </Sec>
  );
}

type Line = { text: string; state: "probe" | "going" | "done" | "failed" };

function FireRow({ s, t, state, report }: { s: Listed; t: Target; state?: Line; report(sid: string, c: Check | null): void }) {
  const check = useProbe(t.machine, t.slots && !t.problem ? probeOf(s) : null);
  useEffect(() => report(s.sid, check), [check, s.sid]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Sec data-row={nameOf(s)}>
      <b>{nameOf(s)}</b>
      <Note>{`точка ${at(s.head.at)} · №${s.head.id}`}</Note>
      <Opts>
        <M>{dirOf(s)}</M>
      </Opts>
      <Note tone={state?.state === "failed" ? "bad" : state?.state === "done" ? "ok" : undefined}>{state?.text ?? check?.text ?? "проверяю папку…"}</Note>
    </Sec>
  );
}

/** Окно «пожара»: все сессии машины по одной, пока окно открыто; закрыли — идущая доходит, остальные ждут на точках. */
function FireWindow({ machine, sessions, fleet, busy, close }: { machine: string; sessions: Listed[]; fleet: Fleet; busy(on: boolean): void; close(): void }) {
  const app = useApp();
  const t = useTarget({ owner: machine });
  const [checks, setChecks] = useState<Record<string, Check | null>>({});
  const [lines, setLines] = useState<Record<string, Line>>({});
  const [run, setRun] = useState<{ done: number; over: boolean } | null>(null);
  const closed = useRef(false);
  const n = sessions.length;
  const go = async () => {
    busy(true);
    setRun({ done: 0, over: false });
    let done = 0;
    for (const s of sessions) {
      if (closed.current) break;
      setLines((l) => ({ ...l, [s.sid]: { text: "поднимается…", state: "going" } }));
      const r = await app.request<{ callsign: string }>("points.raise", raiseOf(s, t.machine, t.slot));
      if (r.ok) {
        done++;
        if (s.callsign) joinProject(app, s.callsign, r.result.callsign);
      }
      const text = r.ok ? `готова — ${r.result.callsign}` : r.error === "not_owner" ? "уже подняли на другой машине" : `не поднялась: ${refused(r.error, { target: t.machine })}`;
      setLines((l) => ({ ...l, [s.sid]: { text, state: r.ok ? "done" : "failed" } }));
      setRun({ done, over: false });
    }
    setRun({ done, over: true });
    busy(false);
    void fleet.read();
  };
  const ready = sessions.every((s) => !blocked(checks[s.sid] ?? null));
  const progress = run ? `Перенос с ${machine} на ${t.machine}: ${run.done} из ${n} готовы${run.over ? "" : " — не закрывайте страницу"}` : "";
  return (
    <Sec dlg data-dlg="fire">
      <H4>{`Перенести сессии ${machine} на другую машину`}</H4>
      <Machines t={t} label="Куда" />
      <Slot t={t} />
      {sessions.map((s) => (
        <FireRow key={s.sid} s={s} t={t} state={lines[s.sid]} report={(sid, c) => setChecks((x) => ({ ...x, [sid]: c }))} />
      ))}
      {run?.over ? (
        <OkCard data-progress={`${run.done}/${n}`}>{progress}</OkCard>
      ) : run ? (
        <Note data-progress={`${run.done}/${n}`}>{progress}</Note>
      ) : null}
      <Opts>
        <Btn
          onClick={() => {
            closed.current = true;
            close();
          }}
        >
          {run ? "Закрыть" : "Отмена"}
        </Btn>
        {run ? null : (
          <Btn pri disabled={!ready || !!t.problem} onClick={() => void go()}>{`Перенести ${n} из ${n} на ${t.machine}`}</Btn>
        )}
      </Opts>
    </Sec>
  );
}

function Fire({ machine, sessions, fleet }: { machine: string; sessions: Listed[]; fleet: Fleet }) {
  const app = useApp();
  const canRaise = app.use(() => (app.roster()?.machines ?? []).some((m) => app.can(m.machine, "points.raise")));
  const left = app.use(() => app.mark("machines.left", machine) as number | undefined);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => app.run("machines.left.read", { machine }), [machine]); // eslint-disable-line react-hooks/exhaustive-deps
  const waiting = `${countOf(sessions.length, "сессия", "сессии", "сессий")} ${sessions.length === 1 ? "ждёт" : "ждут"} на последних точках`;
  return (
    <>
      <Sec tone="bad" data-fire={machine}>
        <b>{`${machine} не на связи${left ? ` с ${at(left)}` : ""} · ${waiting}`}</b>
        {canRaise && !open && !busy ? (
          <Opts>
            <Btn pri onClick={() => setOpen(true)}>
              Перенести на другую машину…
            </Btn>
          </Opts>
        ) : null}
      </Sec>
      {open ? <FireWindow machine={machine} sessions={sessions} fleet={fleet} busy={setBusy} close={() => setOpen(false)} /> : null}
    </>
  );
}

export function Overview() {
  const app = useApp();
  const fleet = useModule<Fleet>();
  const { fleet: data, error } = app.use(() => fleet.get());
  const records = app.use(() => (app.roster()?.sessions ?? []).map((s) => s.callsign));
  const online = app.use(() => (app.roster()?.machines ?? []).map((m) => m.machine));
  useEffect(() => void fleet.read(), [fleet]);
  const word = error ? `points.list: ${error}` : "";
  if (!data) return <Page>{word ? <Note tone="bad">{word}</Note> : "…"}</Page>;
  const inRoster = (s: Listed) => !!s.callsign && records.includes(s.callsign);
  const live = data.sessions.filter(inRoster).sort((a, b) => a.head.at - b.head.at);
  const lost = data.sessions.filter((s) => !online.includes(s.owner));
  const only = data.sessions.filter((s) => online.includes(s.owner) && !inRoster(s));
  const plain = records.filter((c) => !live.some((s) => s.callsign === c));
  const machines = [...new Set(lost.map((s) => s.owner))];
  const sweep = data.sweep ? ` · уборка ${day(data.sweep.at)} ${at(data.sweep.at)} — удалено ${countOf(data.sweep.blocks, "блок", "блока", "блоков")}, ${megabytes(data.sweep.bytes)}` : "";
  return (
    <Page>
      <PageHead title={app.wide ? "Точки" : undefined} />
      {word ? (
        <Note tone="bad" role="alert">
          {word}
        </Note>
      ) : null}
      {machines.map((m) => (
        <Fire key={m} machine={m} sessions={lost.filter((s) => s.owner === m)} fleet={fleet} />
      ))}
      <Opts data-summary="">
        <b>{`${countOf(live.length, "сессия", "сессии", "сессий")} в R2 из ${records.length} на машинах`}</b>
        {machines.map((m) => (
          <Note key={m} tone="bad">{`· ${lost.filter((s) => s.owner === m).length} на ${m} — нет связи`}</Note>
        ))}
        <Note>{`· ${only.length} только в R2`}</Note>
      </Opts>
      <Sec>
        <H4>Последняя точка</H4>
        {live.length ? live.map((s) => <Live key={s.sid} s={s} fleet={fleet} />) : <Note>Сессий в R2 на связи нет.</Note>}
      </Sec>
      {plain.length ? <Note>{`${plain.join(", ")} не в R2`}</Note> : null}
      <Only sessions={only} fleet={fleet} />
      <Note>{`В R2 ${megabytes(data.r2.bytes)}${sweep}`}</Note>
    </Page>
  );
}
