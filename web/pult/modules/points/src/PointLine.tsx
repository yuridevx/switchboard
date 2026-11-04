// Линия и ветки сессии: точки по дням; нажатая точка раскрывает карточку с действиями.
import { Fragment, useMemo, useState } from "react";
import { machineOf } from "@switchboard/protocol";
import { Btn, day, H4, hhmm, Note, Opts, plural, Row, RowBtn, Sec, useApp } from "@switchboard/web-ui";
import { usePoints } from "./store.ts";
import type { Line, LPoint } from "./store.ts";
import type { DialogKind } from "./usePointDialog.ts";

function PointCard({ p, head, machine, open }: { p: LPoint; head: number | null; machine: string; open(kind: DialogKind, from: number): void }) {
  const app = useApp();
  const points = usePoints();
  const last = app.use(() => (points.full(p.id)?.last ?? []) as unknown[][]);
  const canCopy = app.use(() => points.raisers().length > 0);
  const canRollback = app.use(() => !!app.can(machine, "points.raise"));
  return (
    <Sec data-card={p.id}>
      <Row label="когда">
        <span>{`${day(p.at)} ${hhmm(p.at)} · №${p.id}${p.id === head ? " · последняя" : ""}`}</span>
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
        {canCopy ? <Btn onClick={() => open("copy", p.id)}>Скопировать из этой точки…</Btn> : null}
        {p.id !== head && canRollback ? (
          <Btn data-act="rb" onClick={() => open("rb", p.id)}>
            Откатить к этой точке…
          </Btn>
        ) : null}
      </Opts>
    </Sec>
  );
}

function PointRow({ p, picked, toggle }: { p: LPoint; picked: boolean; toggle(): void }) {
  const app = useApp();
  const points = usePoints();
  const first = app.use(() => points.full(p.id)?.last?.[0] as unknown[] | undefined);
  const words = typeof first?.[0] === "string" ? `«${first[0]}»` : p.why;
  return (
    <RowBtn className={p.line ? "pt-pt" : "pt-pt br"} aria-pressed={picked ? "true" : "false"} data-point={p.id} onClick={toggle}>
      <span>{hhmm(p.at)}</span>
      <i />
      <span>{words}</span>
      <em>{p.line ? `№${p.id}` : `ветка · №${p.id}`}</em>
    </RowBtn>
  );
}

export function PointLine({ line, callsign, open }: { line: Line; callsign: string; open(kind: DialogKind, from: number): void }) {
  const machine = machineOf(callsign) ?? "";
  const [picked, setPicked] = useState<number | null>(null);
  const sorted = useMemo(() => [...line.points].sort((a, b) => b.at - a.at), [line.points]);
  return (
    <Sec data-points="">
      <H4>Линия и ветки</H4>
      {sorted.map((p, i) => {
        const d = day(p.at);
        return (
          <Fragment key={p.id}>
            {i === 0 || day(sorted[i - 1].at) !== d ? <div className="pt-day">{d}</div> : null}
            <PointRow p={p} picked={picked === p.id} toggle={() => setPicked(picked === p.id ? null : p.id)} />
            {picked === p.id ? <PointCard p={p} head={line.head} machine={machine} open={open} /> : null}
          </Fragment>
        );
      })}
    </Sec>
  );
}
