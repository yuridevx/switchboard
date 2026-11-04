// Окно действия над точкой: перенос, копия, смена папки, откат. Поля и шаги — usePointDialog.
import { machineOf } from "@switchboard/protocol";
import { Btn, Check, CommitIn, H4, In, M, Note, Opts, OptsLabel, remoteOf, Row, Sec, SlotPick, useApp } from "@switchboard/web-ui";
import { usePoints } from "./store.ts";
import { CheckLine } from "./target.tsx";
import type { Dialog, DialogControl } from "./usePointDialog.ts";
import { canRaise } from "./words.ts";

function MachineRow({ d, c, machine, raisers, busy }: { d: Dialog; c: DialogControl; machine: string; raisers: string[]; busy: boolean }) {
  if (d.kind !== "move" && d.kind !== "copy") {
    return (
      <Row label="Машина">
        <span>{`${machine} — та же`}</span>
      </Row>
    );
  }
  return (
    <>
      <Row label="Машина">
        <Opts>
          {raisers.map((m) => (
            <Btn key={m} aria-pressed={m === d.target ? "true" : "false"} disabled={busy} onClick={() => c.chooseTarget(d, m)}>
              {m}
            </Btn>
          ))}
        </Opts>
      </Row>
      <Row label="Из точки">
        <Opts>
          <Btn aria-pressed={d.from === "fresh" ? "true" : "false"} onClick={() => c.change(d, { from: "fresh" })}>
            сейчас — сохранится свежая
          </Btn>
          {typeof d.from === "number" ? <Btn aria-pressed="true">{`№${d.from}`}</Btn> : null}
        </Opts>
      </Row>
      {d.slots ? <SlotPick label={`Слот на ${d.target}`} slots={d.slots} value={d.slot} on={(slot) => c.patch({ slot })} /> : null}
    </>
  );
}

function RollbackFields({ d, c, remote }: { d: Dialog; c: DialogControl; remote: boolean }) {
  return (
    <>
      <Opts>
        <Btn aria-pressed={d.files === "keep" ? "true" : "false"} onClick={() => c.patch({ files: "keep" })}>
          Оставить как есть
        </Btn>
        <Btn aria-pressed={d.files === "point" ? "true" : "false"} onClick={() => c.patch({ files: "point" })}>
          Вернуть к папке точки
        </Btn>
      </Opts>
      <Note>Нынешнее сначала сохранится веткой «до отката» — из неё можно скопировать или продолжить ею.</Note>
      {remote ? (
        <Sec tone="wait" data-remote="">
          <b>Привязка к claude.ai снимется</b>
          <Note>После отката в claude.ai — новая сессия без прежней истории, кнопка «В claude.ai» поведёт на неё. Прежняя сессия в claude.ai останется как была.</Note>
        </Sec>
      ) : null}
    </>
  );
}

export function PointDialog({ d, c, callsign, sid }: { d: Dialog; c: DialogControl; callsign: string; sid: string }) {
  const app = useApp();
  const points = usePoints();
  const machine = machineOf(callsign) ?? "";
  const raisers = app.use(points.raisers);
  const head = app.use(() => points.line(sid)?.head);
  const dir = app.use(() => points.dirOf(sid));
  const remote = app.use(() => !!remoteOf(points.session(callsign)));

  const numbered = typeof d.from === "number";
  const title = { move: `Перенести ${callsign}`, copy: `Скопировать ${callsign}`, dir: `Сменить папку ${callsign}`, rb: `Откатить ${callsign} к ${numbered ? `точке №${d.from}` : "точке"}` }[d.kind];
  const action = { move: `Перенести на ${d.target}`, copy: `Скопировать на ${d.target}`, dir: "Скопировать и забыть", rb: `Откатить к ${numbered ? `№${d.from}` : "точке"}` }[d.kind];
  const busy = d.phase === "run";
  const blocked = (d.kind === "move" || d.kind === "copy") && !canRaise(d.check);

  return (
    <Sec dlg data-dlg={d.kind}>
      <H4>{title}</H4>
      <MachineRow d={d} c={c} machine={machine} raisers={raisers} busy={busy} />
      {d.kind === "rb" ? (
        <Row label="Папка">
          <M>{dir}</M>
        </Row>
      ) : (
        <Row label={d.kind === "dir" ? "Новая папка" : `Папка на ${d.target}`}>
          <CommitIn mono data-f="dir" value={d.dir} onCommit={(v) => c.change(d, { dir: v })} />
        </Row>
      )}
      {d.kind === "copy" || d.kind === "dir" ? (
        <Row label={d.kind === "copy" ? "Имя копии" : "Имя"}>
          <Opts>
            <In mono data-f="name" value={d.name} onInput={(e) => c.patch({ name: e.currentTarget.value })} />
            <Note>{`→ ${d.name}@${d.target}`}</Note>
          </Opts>
        </Row>
      ) : null}
      <CheckLine check={d.check} target={d.target} />
      {d.kind === "dir" ? <Note>папка — как есть: правки точки не применяются. Папку живой сессии не меняют: claude держит её с запуска. Не поднялась копия — «Забыть» не шлётся.</Note> : null}
      {d.kind === "rb" ? <RollbackFields d={d} c={c} remote={remote} /> : null}
      {d.kind === "copy" ? null : (
        <OptsLabel>
          <Check checked={d.interrupt} onChange={(e) => c.patch({ interrupt: e.currentTarget.checked })} />
          {d.kind === "rb" ? "прервать идущий ответ и откатить сразу (иначе — после конца ответа)" : "прервать ответ и сделать сразу"}
        </OptsLabel>
      )}
      {d.kind === "move" ? <Note>{`Сначала ${machine} остановит сессию и снимет точку, потом ${d.target} поднимет её. Сорвётся подъём — сессия снова пойдёт на ${machine}.`}</Note> : null}
      {d.kind === "copy" ? <Note>Исходная сессия не меняется. У копии своё имя и своя сессия в claude.ai.</Note> : null}
      {d.msg ? (
        <Note tone={d.phase === "err" ? "bad" : d.phase === "done" ? "ok" : "wait"} role="status" data-phase={d.phase}>
          {d.msg}
        </Note>
      ) : null}
      <Opts>
        <Btn onClick={c.close}>{d.phase === "done" ? "Закрыть" : "Отмена"}</Btn>
        {d.phase === "done" ? null : (
          <Btn pri data-act="run" disabled={busy || blocked || typeof head !== "number"} onClick={() => c.run(d)}>
            {action}
          </Btn>
        )}
      </Opts>
    </Sec>
  );
}
