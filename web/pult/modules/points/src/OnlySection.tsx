// «Только в R2»: сессии без живого процесса. Поиск, удаление после ввода имени и подъём на машину из последней точки.
import { useState } from "react";
import { Btn, day, H4, In, M, Note, Opts, Outcome, PageHead, plural, Row, Sec, useApp, useOutcome } from "@switchboard/web-ui";
import { usePoints } from "./store.ts";
import { canRaise, nameOf, say } from "./format.ts";
import { CheckLine, PickMachine } from "./parts.tsx";
import type { CheckResult, FleetSession } from "./store.ts";
import { useTargetPick } from "./useTargetPick.ts";

type Del = { sid: string; name: string; typed: string };
type Move = { s: FleetSession; target: string; slot: string; dir: string; check: CheckResult | null; phase: "" | "run" | "done" | "err"; msg: string };

function DeleteDialog({ d, type, cancel, remove }: { d: Del; type(v: string): void; cancel(): void; remove(): void }) {
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

function MoveDialog({ d, pick, run, close }: { d: Move; pick(m: string): void; run(): void; close(): void }) {
  return (
    <Sec dlg data-dlg="raise">
      <b>{`Поднять ${nameOf(d.s.callsign ?? "")} из точки №${d.s.head.id}`}</b>
      <Row label="Машина">
        <PickMachine cur={d.target} callsign={d.s.callsign ?? undefined} on={pick} />
      </Row>
      <Row label="Слот">
        <span>{d.slot || "без слота"}</span>
      </Row>
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
        {d.phase !== "done" ? (
          <Btn pri disabled={d.phase === "run" || !canRaise(d.check)} onClick={run}>
            {`Поднять на ${d.target}`}
          </Btn>
        ) : null}
      </Opts>
    </Sec>
  );
}

export function OnlySection({ only }: { only: FleetSession[] }) {
  const app = useApp();
  const points = usePoints();
  const hasRaisers = app.use(() => points.raisers().length > 0);
  const [q, setQ] = useState("");
  const [del, setDel] = useState<Del | null>(null);
  const [notes, say2] = useOutcome();
  const [move, setMove] = useState<Move | null>(null);
  const pick = useTargetPick(setMove);

  async function remove(d: Del) {
    const r = await points.deleteSession(d.sid);
    if (!r.ok) return say2("delete", `points.delete: ${r.error}`, "bad");
    setDel(null);
    say2("delete", `${d.name} удалена — ${r.result.points} ${plural(r.result.points, "точка", "точки", "точек")}`, "ok");
  }

  const pickTarget = (target: string, s: FleetSession, dir: string) => pick(target, [{ sid: s.sid, point: s.head.id, dir }], (m, { slots, checks }) => ({ ...m, slot: slots?.[0] ?? "", check: checks[0] }));

  function openMove(s: FleetSession) {
    const target = points.raisers()[0] ?? "";
    const dir = s.dir ?? "~";
    setMove({ s, target, slot: "", dir, check: null, phase: "", msg: "" });
    void pickTarget(target, s, dir);
  }

  async function runMove(d: Move) {
    setMove((m) => m && { ...m, phase: "run", msg: `${d.target} поднимает сессию из точки…` });
    const x = await points.raise({ machine: d.target, sid: d.s.sid, point: d.s.head.id, dir: d.dir, ...(d.slot ? { slot: d.slot } : {}), files: "point" }, d.s.callsign);
    setMove((m) => m && { ...m, phase: x.ok ? "done" : "err", msg: x.ok ? `${nameOf(d.s.callsign ?? "")} поднята: ${x.result.callsign}` : say(x.error, "", d.target) });
    if (x.ok) void points.loadFleet();
  }

  const low = q.toLowerCase();
  const shown = only.filter((s) => !q || [s.callsign, s.dir, day(s.head.at)].some((x) => x?.toLowerCase().includes(low))).sort((a, b) => b.head.at - a.head.at);

  return (
    <Sec data-only="">
      <PageHead>
        <H4>{`Только в R2 · ${only.length}`}</H4>
        <In data-f="q" size={26} placeholder="⌕ имя, папка или месяц…" value={q} onInput={(e) => setQ(e.currentTarget.value)} />
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
                  setDel({ sid: s.sid, name, typed: "" });
                  say2("delete", "");
                }}
              >
                Удалить…
              </Btn>
              {hasRaisers ? <Btn onClick={() => openMove(s)}>Перенести на машину…</Btn> : null}
            </Opts>
            {del?.sid === s.sid ? <DeleteDialog d={del} type={(typed) => setDel((x) => x && { ...x, typed })} cancel={() => setDel(null)} remove={() => void remove(del)} /> : null}
            {move?.s.sid === s.sid ? <MoveDialog d={move} pick={(m) => void pickTarget(m, move.s, move.dir)} run={() => void runMove(move)} close={() => setMove(null)} /> : null}
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
