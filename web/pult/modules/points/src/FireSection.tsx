// «Пожар»: машины хозяина нет в roster. Плашка на машину и перенос её сессий: по одной, следующая — после ответа на предыдущую; points.save не шлётся.
import { useEffect, useRef, useState } from "react";
import { Btn, H4, hhmm, M, Note, Opts, plural, Row, Sec, useApp } from "@switchboard/web-ui";
import { usePoints } from "./store.ts";
import { canRaise, folderText, nameOf, say } from "./format.ts";
import { PickMachine } from "./parts.tsx";
import type { CheckResult, FleetSession } from "./store.ts";
import { useTargetPick } from "./useTargetPick.ts";

type FireRow = { s: FleetSession; dir: string; slot: string; check: CheckResult | null; st: string };
type Fire = { from: string; target: string; rows: FireRow[]; run: boolean; done: number };

function FireDialog({ f, pick, run, close }: { f: Fire; pick(m: string): void; run(): void; close(): void }) {
  const ready = f.rows.every((r) => canRaise(r.check));
  return (
    <Sec dlg data-dlg="fire">
      <H4>{`Перенести сессии ${f.from} на другую машину`}</H4>
      {f.run ? (
        <Sec tone={f.done === f.rows.length ? "ok" : "wait"} role="status" data-progress={`${f.done}/${f.rows.length}`}>
          <b>{`Перенос с ${f.from} на ${f.target}: ${f.done} из ${f.rows.length} готовы${f.done < f.rows.length && f.rows.some((r) => !r.st || r.st.endsWith("…")) ? " — не закрывайте страницу" : ""}`}</b>
        </Sec>
      ) : (
        <Row label="Куда">
          <PickMachine cur={f.target} callsign={f.rows[0]?.s.callsign ?? undefined} on={pick} />
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
          <Btn onClick={close}>Закрыть</Btn>
        </Opts>
      ) : (
        <Opts>
          <Btn onClick={close}>Отмена</Btn>
          <Btn pri disabled={!ready || !f.target} onClick={run}>{`Перенести ${f.rows.length} из ${f.rows.length} на ${f.target}`}</Btn>
        </Opts>
      )}
    </Sec>
  );
}

/** Плашка машины: когда ушла — знает модуль машин; идёт перенос — второй не начать. */
function FirePlate({ m, list, open }: { m: string; list: FleetSession[]; open: (() => void) | null }) {
  const app = useApp();
  const left = app.use(() => app.mark("machines.left", m));
  return (
    <Sec tone="bad" data-fire={m}>
      <b>{`${m} не на связи${left ? ` с ${hhmm(left)}` : ""} · ${list.length} ${plural(list.length, "сессия ждёт", "сессии ждут", "сессий ждут")} на последних точках`}</b>
      <Note>{`Что ${m} допишет после точек, вернётся веткой, если он появится.`}</Note>
      {open ? (
        <Opts>
          <Btn pri onClick={open}>
            Перенести на другую машину…
          </Btn>
        </Opts>
      ) : null}
    </Sec>
  );
}

export function FireSection({ fires }: { fires: Array<[string, FleetSession[]]> }) {
  const app = useApp();
  const points = usePoints();
  const hasRaisers = app.use(() => points.raisers().length > 0);
  const [fire, setFire] = useState<Fire | null>(null);
  const [running, setRunning] = useState(false);
  // закрыли окно или ушли с экрана — текущая доходит, оставшиеся ждут на точках
  const stopped = useRef(false);
  useEffect(() => {
    stopped.current = false;
    return () => {
      stopped.current = true;
    };
  }, []);
  const pickTarget = useTargetPick(setFire);

  const pick = (target: string, rows: FireRow[]) =>
    pickTarget(target, rows.map((r) => ({ sid: r.s.sid, point: r.s.head.id, dir: r.dir })), (f, { slots, checks }) => ({ ...f, rows: f.rows.map((r, i) => ({ ...r, slot: slots ? (slots[0] ?? "") : r.slot, check: checks[i] })) }));

  function open(from: string, list: FleetSession[]) {
    const target = points.raisers()[0] ?? "";
    const rows: FireRow[] = list.map((s) => ({ s, dir: s.dir ?? "~", slot: "", check: null, st: "" }));
    setFire({ from, target, rows, run: false, done: 0 });
    void pick(target, rows);
  }

  async function run(f: Fire) {
    stopped.current = false;
    setRunning(true);
    setFire((x) => x && { ...x, run: true });
    const setSt = (i: number, st: string, done = 0) => setFire((x) => x && { ...x, done: x.done + done, rows: x.rows.map((r, n) => (n === i ? { ...r, st } : r)) });
    for (const [i, r] of f.rows.entries()) {
      if (stopped.current) break;
      setSt(i, "поднимается…");
      const x = await points.raise({ machine: f.target, sid: r.s.sid, point: r.s.head.id, dir: r.dir, ...(r.slot ? { slot: r.slot } : {}), files: "point" }, r.s.callsign);
      setSt(i, x.ok ? `готова — ${x.result.callsign}` : x.error === "not_owner" ? "уже подняли на другой машине" : `не поднялась: ${say(x.error)}`, x.ok ? 1 : 0);
    }
    setRunning(false);
    void points.loadFleet();
  }

  function close() {
    stopped.current = true;
    setFire(null);
  }

  return (
    <>
      {fires.map(([m, list]) => (
        <FirePlate key={m} m={m} list={list} open={!fire && !running && hasRaisers ? () => open(m, list) : null} />
      ))}
      {fire ? <FireDialog f={fire} pick={(m) => void pick(m, fire.rows)} run={() => void run(fire)} close={close} /> : null}
    </>
  );
}
