// «Только в R2»: сессии без живого процесса. Поиск, удаление после ввода имени и подъём на машину из последней точки.
import { useState } from "react";
import { Btn, day, H4, In, M, Note, Opts, Outcome, PageHead, plural, Row, Sec, slotChoice, slotOf, SlotPick, useApp, useOutcome } from "@switchboard/web-ui";
import { usePoints } from "./store.ts";
import type { CheckResult, FleetSession, Slots } from "./store.ts";
import { CheckLine, PickMachine, useChooseTarget } from "./target.tsx";
import { canRaise, nameOf, refusal } from "./words.ts";

type Deleting = { sid: string; name: string; typed: string };
type Raising = { s: FleetSession; target: string; slots: Slots | null; slot: string; dir: string; check: CheckResult | null; phase: "" | "run" | "done" | "err"; msg: string };

function DeleteDialog({ d, type, cancel, remove }: { d: Deleting; type(v: string): void; cancel(): void; remove(): void }) {
  return (
    <Sec dlg data-dlg="delete">
      <b>{`Удалить точки «${d.name}» насовсем`}</b>
      <Note>Строки точек и блоки без ссылок уйдут из R2 сразу, в том же запросе; блоки, нужные копиям, останутся. Отменить нельзя — отмены у удаления нет.</Note>
      <Opts>
        <span>{`Введите имя сессии: ${d.name}`}</span>
        <In mono data-f={`del:${d.sid}`} placeholder={d.name} value={d.typed} onInput={(e) => type(e.currentTarget.value)} />
      </Opts>
      <Opts>
        <Btn onClick={cancel}>Отмена</Btn>
        <Btn bad data-act="delete" disabled={d.typed !== d.name} onClick={remove}>
          Удалить насовсем
        </Btn>
      </Opts>
    </Sec>
  );
}

function RaiseDialog({ d, pick, chooseSlot, run, close }: { d: Raising; pick(m: string): void; chooseSlot(slot: string): void; run(): void; close(): void }) {
  return (
    <Sec dlg data-dlg="raise">
      <b>{`Поднять ${nameOf(d.s.callsign ?? "")} из точки №${d.s.head.id}`}</b>
      <Row label="Машина">
        <PickMachine cur={d.target} callsign={d.s.callsign} on={pick} />
      </Row>
      {d.slots ? <SlotPick slots={d.slots} value={d.slot} on={chooseSlot} /> : null}
      <Row label="Папка">
        <M>{d.dir}</M>
      </Row>
      <CheckLine check={d.check} target={d.target} />
      {d.msg ? (
        <Note tone={d.phase === "err" ? "bad" : d.phase === "done" ? "ok" : undefined} role="status">
          {d.msg}
        </Note>
      ) : null}
      <Opts>
        <Btn onClick={close}>{d.phase === "done" ? "Закрыть" : "Отмена"}</Btn>
        {d.phase === "done" ? null : (
          <Btn pri disabled={d.phase === "run" || !canRaise(d.check)} onClick={run}>
            {`Поднять на ${d.target}`}
          </Btn>
        )}
      </Opts>
    </Sec>
  );
}

export function OnlySection({ only }: { only: FleetSession[] }) {
  const app = useApp();
  const points = usePoints();
  const hasRaisers = app.use(() => points.raisers().length > 0);
  const [query, setQuery] = useState("");
  const [deleting, setDeleting] = useState<Deleting | null>(null);
  const [notes, note] = useOutcome();
  const [raising, setRaising] = useState<Raising | null>(null);
  const choose = useChooseTarget(setRaising);

  async function remove(d: Deleting) {
    const r = await points.deleteSession(d.sid);
    if (!r.ok) return note("delete", `points.delete: ${r.error}`, "bad");
    setDeleting(null);
    note("delete", `${d.name} удалена — ${r.result.points} ${plural(r.result.points, "точка", "точки", "точек")}`, "ok");
  }

  const chooseTarget = (target: string, s: FleetSession, dir: string) =>
    choose(target, [{ sid: s.sid, point: s.head.id, dir }], (d, { slots, checks }) => ({ ...d, slots, slot: slots ? slotChoice(Object.keys(slots), slotOf(points.session(s.callsign ?? ""))?.name) : "", check: checks[0] }));

  function openRaise(s: FleetSession) {
    const target = points.raisers()[0] ?? "";
    const dir = s.dir ?? "~";
    setRaising({ s, target, slots: null, slot: "", dir, check: null, phase: "", msg: "" });
    void chooseTarget(target, s, dir);
  }

  async function runRaise(d: Raising) {
    setRaising((x) => x && { ...x, phase: "run", msg: `${d.target} поднимает сессию из точки…` });
    const r = await points.raise({ machine: d.target, sid: d.s.sid, point: d.s.head.id, dir: d.dir, ...(d.slot ? { slot: d.slot } : {}), files: "point" }, d.s.callsign);
    setRaising((x) => x && { ...x, phase: r.ok ? "done" : "err", msg: r.ok ? `${nameOf(d.s.callsign ?? "")} поднята: ${r.result.callsign}` : refusal(r.error, "", d.target) });
    if (r.ok) void points.loadFleet();
  }

  const q = query.toLowerCase();
  const shown = only.filter((s) => !q || [s.callsign, s.dir, day(s.head.at)].some((x) => x?.toLowerCase().includes(q))).sort((a, b) => b.head.at - a.head.at);

  return (
    <Sec data-only="">
      <PageHead>
        <H4>{`Только в R2 · ${only.length}`}</H4>
        <In data-f="q" size={26} placeholder="⌕ имя, папка или месяц…" value={query} onInput={(e) => setQuery(e.currentTarget.value)} />
      </PageHead>
      {shown.map((s) => {
        const name = nameOf(s.callsign ?? s.sid);
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
                  setDeleting({ sid: s.sid, name, typed: "" });
                  note("delete", "");
                }}
              >
                Удалить…
              </Btn>
              {hasRaisers ? <Btn onClick={() => openRaise(s)}>Перенести на машину…</Btn> : null}
            </Opts>
            {deleting?.sid === s.sid ? <DeleteDialog d={deleting} type={(typed) => setDeleting((x) => x && { ...x, typed })} cancel={() => setDeleting(null)} remove={() => void remove(deleting)} /> : null}
            {raising?.s.sid === s.sid ? <RaiseDialog d={raising} pick={(m) => void chooseTarget(m, raising.s, raising.dir)} chooseSlot={(slot) => setRaising((x) => x && { ...x, slot })} run={() => void runRaise(raising)} close={() => setRaising(null)} /> : null}
          </div>
        );
      })}
      {notes.delete?.tone === "ok" ? (
        <Sec tone="ok" role="status">
          <b>{notes.delete.text}</b>
          <Note>Запись — в «Журнале флота».</Note>
        </Sec>
      ) : (
        <Outcome note={notes.delete} />
      )}
    </Sec>
  );
}
