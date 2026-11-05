// Окна вкладки: перенос, копия, смена папки и откат — шаги по порядку, каждый запрос после ответа предыдущего.
import { useState } from "react";
import { Btn, Check, CommitIn, H4, In, M, Note, OptsLabel, Opts, remoteOf, Row, Sec, sessionOf, slotChoice, slotOf, useApp } from "@switchboard/web-ui";
import type { ListedPoint } from "@switchboard/points";
import { CheckLine } from "./Overview.tsx";
import { joinProject, Machines, Slot, useProbe, useTarget } from "./target.tsx";
import { blocked, refused } from "./words.ts";

export type Kind = "move" | "copy" | "dir" | "rb";

type Props = { kind: Kind; callsign: string; sid: string; head: ListedPoint; from: ListedPoint | null; close(): void; reload(): void };
type Phase = { kind: "run" | "err" | "done"; text: string };

const TITLES: Record<Kind, (callsign: string, point?: number) => string> = {
  move: (c) => `Перенести ${c}`,
  copy: (c) => `Скопировать ${c}`,
  dir: (c) => `Сменить папку ${c}`,
  rb: (c, p) => `Откатить ${c} к точке №${p}`,
};

export function Dialog({ kind, callsign, sid, head, from, close, reload }: Props) {
  const app = useApp();
  const [name, here] = callsign.split("@");
  const session = sessionOf(app, callsign);
  const near = (app.mark("project.machines", (app.mark("project.of", callsign) as { id: string } | null | undefined)?.id ?? "") as string[] | undefined) ?? [];
  const t = useTarget({ owner: here, near: [...near, here], slot: slotOf(session)?.name });
  const fixed = kind === "dir" || kind === "rb";
  const named = kind === "copy" || kind === "dir";
  const machine = fixed ? here : t.machine;

  const suffix = kind === "copy" ? "-copy" : "-v2";
  const [newName, setName] = useState(`${name}${suffix}`);
  const pointDir = from?.dir ?? head.dir ?? "~";
  const [dir, setDir] = useState(named ? `${pointDir}${suffix}` : pointDir);
  const [point, setPoint] = useState<ListedPoint | null>(from);
  const [folder, setFolder] = useState<"keep" | "point">("keep");
  const [cut, setCut] = useState(false);
  const [phase, setPhase] = useState<Phase | null>(null);
  const shown = point ?? head;

  const check = useProbe(machine, !fixed && t.slots && !t.problem ? { sid, point: shown.id, dir, files: "point" } : null);
  const going = phase?.kind === "run";
  const done = phase?.kind === "done";
  const problem = fixed ? "" : t.problem;

  const say = (kind: Phase["kind"], text: string) => setPhase({ kind, text });
  const failed = (word: string) => say("err", refused(word, { who: name, target: machine, from: here }));

  /** Слот копии в новой папке: нынешний; нет — первый, если их несколько; один — решает машина. */
  async function slotOfCopy(): Promise<{ slot?: string } | null> {
    const own = slotOf(session)?.name;
    if (own) return { slot: own };
    const r = await app.read<{ slots: Record<string, unknown> }>("machine.accounts", { machine });
    if (!r.ok) {
      say("err", `machine.accounts: ${r.error}`);
      return null;
    }
    const slot = slotChoice(Object.keys(r.result.slots));
    return slot ? { slot } : {};
  }

  /** Свежая точка: перенос, откат и смена папки — со стопом, копия — без. */
  async function save(): Promise<number | null> {
    const stop = kind === "copy" ? {} : { stop: true, ...(cut ? { interrupt: true } : {}) };
    say("run", kind === "copy" ? `${here} кладёт свежую точку…` : `${here} дожидается конца ответа, останавливает сессию и кладёт точку…`);
    const r = await app.request<{ point: number }>("points.save", { callsign, ...stop });
    if (r.ok) return r.result.point;
    failed(r.error);
    return null;
  }

  async function run() {
    const extra = kind === "dir" ? await slotOfCopy() : t.slot && !fixed ? { slot: t.slot } : {};
    if (!extra) return;
    const number = (kind === "copy" && point) ? point.id : await save();
    if (number === null) return;
    const target = kind === "rb" ? (from as ListedPoint).id : number;
    say("run", `${machine} поднимает сессию из точки №${target}…`);
    const copy = kind === "copy" || kind === "dir" ? { copy: true, name: newName } : {};
    const files = kind === "move" || kind === "copy" ? "point" : kind === "dir" ? "keep" : folder;
    const r = await app.request<{ callsign: string; branch?: string | null }>("points.raise", { machine, sid, point: target, dir, files, ...copy, ...extra });
    if (!r.ok) return kind === "dir" && r.error === "open_failed" ? say("err", `Копия не поднялась — «Забыть» не отправлен, ${callsign} остаётся остановленной`) : failed(r.error);
    const raised = r.result.callsign;
    if (raised !== callsign) joinProject(app, callsign, raised);
    reload();
    if (kind === "move") return say("done", `${name} перенесена на ${machine}: ${raised}. ${here} её отпустил.`);
    if (kind === "copy") return say("done", `Копия поднята: ${raised}. Исходная сессия не менялась.`);
    if (kind === "rb") return say("done", `Откат: ${callsign} поднята из точки №${target}; нынешнее — веткой «до отката»${r.result.branch ? `, папка на ветке git ${r.result.branch}` : ""}. Новая ссылка claude.ai придёт в roster.`);
    say("run", `«Забыть» ${callsign}…`);
    const gone = await app.request("session.remove", { callsign });
    if (!gone.ok) return failed(gone.error);
    say("done", `Копия в новой папке: ${raised}; ${callsign} забыта, её точки остались в R2.`);
  }

  const label = { move: `Перенести на ${machine}`, copy: `Скопировать на ${machine}`, dir: "Скопировать и забыть", rb: `Откатить к №${shown.id}` }[kind];
  return (
    <Sec dlg data-dlg={kind}>
      <H4>{TITLES[kind](callsign, shown.id)}</H4>
      {fixed ? (
        <Row label="Машина">
          <span>{`${here} — та же`}</span>
        </Row>
      ) : (
        <>
          <Machines t={t} />
          <Row label="Из точки">
            <Opts>
              {from && point ? <Btn aria-pressed="true">{`№${point.id}`}</Btn> : null}
              <Btn aria-pressed={!point} onClick={() => setPoint(null)}>
                сейчас — сохранится свежая
              </Btn>
            </Opts>
          </Row>
          <Slot t={t} />
        </>
      )}
      {kind === "rb" ? (
        <RollbackFolder dir={dir} folder={folder} set={setFolder} />
      ) : (
        <Row label={kind === "dir" ? "Новая папка" : `Папка на ${machine}`}>
          <CommitIn mono data-f="dir" value={dir} onCommit={setDir} />
        </Row>
      )}
      {named ? (
        <Row label={kind === "copy" ? "Имя копии" : "Имя"}>
          <Opts>
            <In mono data-f="name" value={newName} onInput={(e) => setName(e.currentTarget.value)} />
            <Note>{`→ ${newName}@${machine}`}</Note>
          </Opts>
        </Row>
      ) : null}
      <CheckLine check={problem ? { key: "error", text: problem, tone: "bad" } : check} />
      {kind === "rb" && remoteOf(session) ? <RemoteWarning /> : null}
      {kind === "copy" ? null : (
        <OptsLabel>
          <Check checked={cut} onChange={(e) => setCut(e.currentTarget.checked)} />
          {kind === "rb" ? "прервать идущий ответ и откатить сразу (иначе — после конца ответа)" : "прервать ответ и сделать сразу"}
        </OptsLabel>
      )}
      {phase ? <PhaseLine phase={phase} /> : null}
      <Opts>
        <Btn onClick={close}>{done ? "Закрыть" : "Отмена"}</Btn>
        {done ? null : (
          <Btn pri data-act="run" disabled={going || !!problem || (!fixed && blocked(check))} onClick={() => void run()}>
            {label}
          </Btn>
        )}
      </Opts>
    </Sec>
  );
}

function RollbackFolder({ dir, folder, set }: { dir: string; folder: "keep" | "point"; set(f: "keep" | "point"): void }) {
  return (
    <>
      <Row label="Папка">
        <M>{dir}</M>
      </Row>
      <Opts>
        <Btn aria-pressed={folder === "keep"} onClick={() => set("keep")}>
          Оставить как есть
        </Btn>
        <Btn aria-pressed={folder === "point"} onClick={() => set("point")}>
          Вернуть к папке точки
        </Btn>
      </Opts>
    </>
  );
}

const RemoteWarning = () => (
  <Sec tone="wait" data-remote="">
    <b>Привязка к claude.ai снимется</b>
    <Note>После отката в claude.ai — новая сессия без прежней истории, кнопка «В claude.ai» поведёт на неё. Прежняя сессия в claude.ai останется как была.</Note>
  </Sec>
);

const PhaseLine = ({ phase }: { phase: Phase }) => (
  <Note data-phase={phase.kind} role={phase.kind === "err" ? "alert" : "status"} tone={phase.kind === "err" ? "bad" : phase.kind === "done" ? "ok" : undefined}>
    {phase.text}
  </Note>
);
