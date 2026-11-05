// Окна действий с точкой: перенос, копия, смена папки, откат. Шаги идут по одному, каждый запрос — после ответа предыдущего:
// points.save → points.raise → (смена папки) session.remove прежней.
import { machineOf, nameOf } from "@switchboard/protocol";
import { useState } from "react";
import { Btn, Check, CommitIn, H4, In, M, Note, Opts, OptsLabel, remoteOf, Row, Sec, sessionOf, slotChoice, slotOf, useApp } from "@switchboard/web-ui";
import type { LinePoint } from "./Tab.tsx";
import { CheckLine, MachineRow, runnable, SlotRow, useProbe, useTarget } from "./target.tsx";
import { wordText } from "./words.ts";

/** До стольких машин все — кнопками; больше — ближние кнопками, остальные списком. */
const MANY_MACHINES = 6;

export type Kind = "move" | "copy" | "dir" | "rb";
type Phase = { kind: "run" | "done" | "err"; text: string };

type Props = { kind: Kind; callsign: string; sid: string; head: LinePoint | undefined; from?: LinePoint; near: string[]; changed(): void; close(): void };

export function PointDialog({ kind, callsign, sid, head, from: chosen, near, changed, close }: Props) {
  const app = useApp();
  const name = nameOf(callsign);
  const own = machineOf(callsign) ?? "";
  const session = app.use(() => sessionOf(app, callsign));
  const remote = app.use(() => !!remoteOf(sessionOf(app, callsign)));
  const moving = kind === "move" || kind === "copy";
  const base = chosen?.dir ?? head?.dir ?? "~";

  const t = useTarget((all) => (moving ? (all.find((m) => m !== own) ?? all[0] ?? "") : own), slotOf(session)?.name ?? "");
  const [from, setFrom] = useState(chosen);
  const [dir, setDir] = useState(kind === "copy" ? `${base}-copy` : kind === "dir" ? `${base}-v2` : base);
  const [copyName, setCopyName] = useState(kind === "copy" ? `${name}-copy` : `${name}-v2`);
  const [interrupt, setInterrupt] = useState(false);
  const [keep, setKeep] = useState(true);
  const [phase, setPhase] = useState<Phase | null>(null);
  const target = moving ? t.machine : own;
  const check = useProbe(t, moving ? { sid, point: from?.id ?? head?.id, dir } : null);

  const fail = (text: string) => setPhase({ kind: "err", text });

  /** Слот копии при смене папки: нынешний; без него — первый на машине. Список не пришёл — сессию не трогаем. */
  async function dirSlot(): Promise<{ slot?: string } | null> {
    const mine = slotOf(session)?.name;
    if (mine) return { slot: mine };
    const r = await app.read<{ slots?: Record<string, unknown> }>("machine.accounts", { machine: own });
    if (!r.ok) {
      fail(`machine.accounts: ${r.error}`);
      return null;
    }
    const slot = slotChoice(Object.keys(r.result.slots ?? {}));
    return slot ? { slot } : {};
  }

  async function save(): Promise<number | null> {
    setPhase({ kind: "run", text: kind === "copy" ? `${own} кладёт свежую точку…` : `${own} дожидается конца ответа, останавливает сессию и кладёт точку…` });
    const r = await app.request<{ point: number }>("points.save", { callsign, ...(kind === "copy" ? {} : { stop: true, ...(interrupt ? { interrupt: true } : {}) }) });
    if (!r.ok) {
      fail(wordText(r.error, { name, target }));
      return null;
    }
    return r.result.point;
  }

  async function go(): Promise<void> {
    const slot = kind === "dir" ? await dirSlot() : kind === "rb" ? {} : t.slot ? { slot: t.slot } : {};
    if (!slot) return;
    const saved = kind === "copy" && from ? from.id : await save();
    if (saved === null) return;
    const point = kind === "rb" ? chosen!.id : saved;
    setPhase({ kind: "run", text: `${target} поднимает сессию из точки №${point}…` });
    const raised = await app.request<{ callsign: string; branch?: string | null }>("points.raise", {
      machine: target,
      sid,
      point,
      dir,
      files: kind === "dir" || (kind === "rb" && keep) ? "keep" : "point",
      ...(kind === "copy" || kind === "dir" ? { copy: true, name: copyName } : {}),
      ...slot,
    });
    changed();
    if (!raised.ok) {
      if (kind === "dir") return fail(`Копия не поднялась — «Забыть» не отправлен, ${callsign} остаётся остановленной`);
      return fail(wordText(raised.error, { name, target, ...(kind === "move" ? { from: own } : {}) }));
    }
    const made = raised.result.callsign;
    const project = app.mark("project.of", callsign) as { id: string } | null | undefined;
    if (project && made !== callsign) app.run("board.assign", { callsign: made, project: project.id });

    if (kind === "dir") {
      setPhase({ kind: "run", text: `«Забыть» ${callsign}…` });
      const removed = await app.request("session.remove", { callsign });
      if (!removed.ok) return fail(wordText(removed.error, { name }));
      setPhase({ kind: "done", text: `Копия в новой папке: ${made}; ${callsign} забыта, её точки остались в R2.` });
    } else if (kind === "rb") {
      const branch = raised.result.branch ? `, папка на ветке git ${raised.result.branch}` : "";
      setPhase({ kind: "done", text: `Откат: ${callsign} поднята из точки №${point}; нынешнее — веткой «до отката»${branch}. Новая ссылка claude.ai придёт в roster.` });
    } else if (kind === "copy") {
      setPhase({ kind: "done", text: `Копия поднята: ${made}. Исходная сессия не менялась.` });
    } else {
      setPhase({ kind: "done", text: `${name} перенесена на ${target}: ${made}. ${own} её отпустил.` });
    }
    changed();
  }

  const running = phase?.kind === "run";
  const done = phase?.kind === "done";
  const titles: Record<Kind, string> = { move: `Перенести ${callsign}`, copy: `Скопировать ${callsign}`, dir: `Сменить папку ${callsign}`, rb: `Откатить ${callsign} к точке №${chosen?.id}` };
  const runs: Record<Kind, string> = { move: `Перенести на ${target}`, copy: `Скопировать на ${target}`, dir: "Скопировать и забыть", rb: `Откатить к №${chosen?.id}` };
  const nameRow = (label: string) => (
    <Row label={label}>
      <Opts>
        <In mono data-f="name" value={copyName} onInput={(e) => setCopyName(e.currentTarget.value)} />
        <Note>{`→ ${copyName}@${target}`}</Note>
      </Opts>
    </Row>
  );
  const interruptBox = (label: string) => (
    <OptsLabel>
      <Check checked={interrupt} onChange={(e) => setInterrupt(e.currentTarget.checked)} />
      {label}
    </OptsLabel>
  );

  return (
    <Sec dlg data-dlg={kind}>
      <H4>{titles[kind]}</H4>
      {moving ? (
        <>
          <MachineRow label="Машина" t={t} near={t.machines.length <= MANY_MACHINES ? t.machines : [...near, own]} />
          <Row label="Из точки">
            <Opts>
              {from ? (
                <Btn aria-pressed="true">{`№${from.id}`}</Btn>
              ) : null}
              <Btn aria-pressed={from ? "false" : "true"} onClick={() => setFrom(undefined)}>
                сейчас — сохранится свежая
              </Btn>
            </Opts>
          </Row>
          <SlotRow t={t} label={`Слот на ${target}`} check={check} />
          <Row label={`Папка на ${target}`}>
            <CommitIn mono data-f="dir" value={dir} onCommit={setDir} />
          </Row>
          {kind === "copy" ? nameRow("Имя копии") : null}
          <CheckLine check={check} />
          {kind === "move" ? interruptBox("прервать ответ и сделать сразу") : null}
        </>
      ) : (
        <>
          <Row label="Машина">
            <span>{`${own} — та же`}</span>
          </Row>
          {kind === "dir" ? (
            <>
              <Row label="Новая папка">
                <CommitIn mono data-f="dir" value={dir} onCommit={setDir} />
              </Row>
              {nameRow("Имя")}
              {interruptBox("прервать ответ и сделать сразу")}
            </>
          ) : (
            <>
              <Row label="Папка">
                <M>{dir}</M>
              </Row>
              <Opts>
                <Btn aria-pressed={keep ? "true" : "false"} onClick={() => setKeep(true)}>
                  Оставить как есть
                </Btn>
                <Btn aria-pressed={keep ? "false" : "true"} onClick={() => setKeep(false)}>
                  Вернуть к папке точки
                </Btn>
              </Opts>
              {remote ? (
                <Sec tone="wait" data-remote="">
                  <b>Привязка к claude.ai снимется</b>
                  <Note>После отката в claude.ai — новая сессия без прежней истории, кнопка «В claude.ai» поведёт на неё. Прежняя сессия в claude.ai останется как была.</Note>
                </Sec>
              ) : null}
              {interruptBox("прервать идущий ответ и откатить сразу (иначе — после конца ответа)")}
            </>
          )}
        </>
      )}
      {phase ? (
        <Note role={phase.kind === "err" ? "alert" : "status"} data-phase={phase.kind} tone={phase.kind === "done" ? "ok" : phase.kind === "err" ? "bad" : undefined}>
          {phase.text}
        </Note>
      ) : null}
      <Opts>
        <Btn onClick={close}>{done ? "Закрыть" : "Отмена"}</Btn>
        {done ? null : (
          <Btn pri data-act="run" disabled={running || (moving && !runnable(check))} onClick={() => void go()}>
            {runs[kind]}
          </Btn>
        )}
      </Opts>
    </Sec>
  );
}
