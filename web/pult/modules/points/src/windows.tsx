// Окна «Сессий»: подъём сессии без живой копии, удаление из архива и «пожар» — машина хозяина не на связи, её сессии ждут на точках.
import { useEffect, useRef, useState } from "react";
import { at, Btn, H4, In, M, machinesWith, Note, Opts, Outcome, Row, Sec, useApp } from "@switchboard/web-ui";
import { titleOf, type Fleet, type Listed } from "./store.ts";
import { joinProject, Machines, Slot, useProbe, useTarget, type Target } from "./target.tsx";
import { blocked, countOf, refused, type Check } from "./words.ts";

const dirOf = (s: Listed) => s.dir ?? "~";
const probeOf = (s: Listed, point = s.head.id) => ({ sid: s.sid, point, dir: dirOf(s), files: "point" });
const raiseOf = (s: Listed, machine: string, slot: string, point = s.head.id) => ({ ...probeOf(s, point), machine, ...(slot ? { slot } : {}) });

/** Окно подъёма сессии без живой копии: из выбранной точки на машину флота. */
export function RaiseWindow({ s, point, fleet, close, raised }: { s: Listed; point: number; fleet: Fleet; close(): void; raised?(callsign: string): void }) {
  const app = useApp();
  const t = useTarget({ owner: s.owner });
  const check = useProbe(t.machine, t.slots && !t.problem ? probeOf(s, point) : null);
  const [note, setNote] = useState<{ text: string; tone?: "ok" | "bad" } | null>(null);
  const [going, setGoing] = useState(false);
  const done = note?.tone === "ok";
  const name = titleOf(s);
  const raise = async () => {
    setGoing(true);
    setNote({ text: `${t.machine} поднимает сессию из точки…` });
    const r = await app.request<{ callsign: string }>("points.raise", raiseOf(s, t.machine, t.slot, point));
    setGoing(false);
    if (!r.ok) return setNote({ text: refused(r.error, { target: t.machine }), tone: "bad" });
    setNote({ text: `${name} поднята: ${r.result.callsign}`, tone: "ok" });
    if (s.callsign) joinProject(app, s.callsign, r.result.callsign);
    void fleet.read();
    raised?.(r.result.callsign);
  };
  return (
    <Sec dlg data-dlg="raise">
      <b>{`Поднять ${name} из точки №${point}`}</b>
      <Machines t={t} />
      <Slot t={t} label="Слот" />
      <Row label="Папка">
        <M>{dirOf(s)}</M>
      </Row>
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
  return check?.text ? (
    <Note data-check={check.key} tone={check.tone}>
      {check.text}
    </Note>
  ) : null;
}

/** Удаление сессии из архива: подтверждение именем. */
export function DeleteWindow({ s, go, close }: { s: Listed; go(): void; close(): void }) {
  const [typed, setTyped] = useState("");
  const name = titleOf(s);
  return (
    <Sec dlg data-dlg="delete">
      <b>{`Удалить «${name}» из архива насовсем`}</b>
      <Note>Точки и блоки без ссылок уйдут из хранилища сразу; блоки, нужные копиям, останутся. Отмены нет.</Note>
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

function FireRow({ s, t, going, line, report }: { s: Listed; t: Target; going: boolean; line?: string; report(sid: string, c: Check | null): void }) {
  const check = useProbe(t.machine, t.slots && !t.problem ? probeOf(s) : null);
  // итог пробы — по ключу: объект проверки новый на каждой отрисовке, по нему окно перерисовывалось бы без конца
  useEffect(() => report(s.sid, check), [check?.key, s.sid]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Sec data-row={titleOf(s)}>
      <b>{titleOf(s)}</b>
      <Note>{`точка ${at(s.head.at)} · №${s.head.id}`}</Note>
      {going ? (
        <Note>{line}</Note>
      ) : (
        <>
          <Opts>
            <M>{dirOf(s)}</M>
          </Opts>
          <Note>{t.problem || (check ? check.text : "проверяю папку…")}</Note>
        </>
      )}
    </Sec>
  );
}

/** Окно «пожара»: все сессии машины по одной, пока окно открыто; закрыли — идущая доходит, остальные ждут на точках. */
function FireWindow({ machine, sessions, fleet, close }: { machine: string; sessions: Listed[]; fleet: Fleet; close(): void }) {
  const app = useApp();
  const t = useTarget({ owner: machine });
  const [checks, setChecks] = useState<Record<string, Check | null>>({});
  const [lines, setLines] = useState<Record<string, string>>({});
  const [run, setRun] = useState<{ done: number; over: boolean } | null>(null);
  const closed = useRef(false);
  useEffect(
    () => () => {
      closed.current = true;
    },
    [],
  );
  const n = sessions.length;
  const go = async () => {
    fleet.moving(true);
    setRun({ done: 0, over: false });
    let done = 0;
    for (const s of sessions) {
      if (closed.current) break;
      setLines((l) => ({ ...l, [s.sid]: "поднимается…" }));
      const r = await app.request<{ callsign: string }>("points.raise", raiseOf(s, t.machine, t.slot));
      if (r.ok) {
        done++;
        if (s.callsign) joinProject(app, s.callsign, r.result.callsign);
      }
      setLines((l) => ({ ...l, [s.sid]: r.ok ? `готова — ${r.result.callsign}` : `не поднялась: ${refused(r.error, { target: t.machine })}` }));
      setRun({ done, over: false });
    }
    setRun({ done, over: true });
    fleet.moving(false);
    void fleet.read();
  };
  const ready = sessions.every((s) => !blocked(checks[s.sid] ?? null));
  const progress = run ? `Перенос с ${machine} на ${t.machine}: ${run.done} из ${n} готовы${run.over ? "" : " — не закрывайте страницу"}` : "";
  return (
    <Sec dlg data-dlg="fire">
      <H4>{`Перенести сессии ${machine} на другую машину`}</H4>
      {run ? (
        <Sec role="status" tone={run.over && run.done === n ? "ok" : "wait"} data-progress={`${run.done}/${n}`}>
          <b>{progress}</b>
        </Sec>
      ) : (
        <>
          <Machines t={t} label="Куда" />
          <Slot t={t} label={`Слот на ${t.machine}`} />
        </>
      )}
      {sessions.map((s) => (
        <FireRow key={s.sid} s={s} t={t} going={!!run} line={lines[s.sid]} report={(sid, c) => setChecks((x) => ({ ...x, [sid]: c }))} />
      ))}
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

export function Fire({ machine, sessions, fleet }: { machine: string; sessions: Listed[]; fleet: Fleet }) {
  const app = useApp();
  const canRaise = app.use(() => machinesWith(app, "points.raise").length > 0 && !fleet.get().moving);
  const left = app.use(() => app.mark("machines.left", machine) as number | undefined);
  const [open, setOpen] = useState(false);
  useEffect(() => app.run("machines.left.read", { machine }), [machine]); // eslint-disable-line react-hooks/exhaustive-deps
  const waiting = `${countOf(sessions.length, "сессия", "сессии", "сессий")} ${sessions.length === 1 ? "ждёт" : "ждут"} на последних точках`;
  return (
    <>
      <Sec tone="bad" data-fire={machine}>
        <b>{`${machine} не на связи${left ? ` с ${at(left)}` : ""} · ${waiting}`}</b>
        {canRaise && !open ? (
          <Opts>
            <Btn pri onClick={() => setOpen(true)}>
              Перенести на другую машину…
            </Btn>
          </Opts>
        ) : null}
      </Sec>
      {open ? <FireWindow machine={machine} sessions={sessions} fleet={fleet} close={() => setOpen(false)} /> : null}
    </>
  );
}

