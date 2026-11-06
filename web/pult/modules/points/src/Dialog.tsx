// Окна вкладки: перенос, копия, смена папки и откат — шаги по порядку, каждый запрос после ответа предыдущего.
import { useState } from "react";
import { Btn, Check, CommitIn, H4, In, M, Note, OptsLabel, Opts, remoteOf, Row, Sec, sessionOf, slotChoice, slotOf, useApp } from "@switchboard/web-ui";
import type { ListedPoint } from "@switchboard/points";
import { CheckLine } from "./Overview.tsx";
import { joinProject, Machines, nearOf, Slot, useProbe, useTarget } from "./target.tsx";
import { blocked, refused } from "./words.ts";

export type Kind = "move" | "copy" | "dir" | "rb";

type Props = { kind: Kind; callsign: string; sid: string; head: ListedPoint; from: ListedPoint | null; close(): void; changed(): void };
type Phase = { kind: "run" | "err" | "done"; text: string };
/** Что выбрано в окне к запуску. */
type Form = { machine: string; slot: string; dir: string; name: string; point: ListedPoint | null; files: "keep" | "point"; cut: boolean };
type Raised = { callsign: string; branch?: string | null };

const TITLES: Record<Kind, (callsign: string, point: number) => string> = {
  move: (c) => `Перенести ${c}`,
  copy: (c) => `Скопировать ${c}`,
  dir: (c) => `Сменить папку ${c}`,
  rb: (c, p) => `Откатить ${c} к точке №${p}`,
};

/** Шаги окна: слот копии → свежая точка → подъём → «Забыть» прежней. */
function useSteps({ kind, callsign, sid, from, changed }: Props, f: Form) {
  const app = useApp();
  const [name, here] = callsign.split("@");
  const [phase, setPhase] = useState<Phase | null>(null);
  const say = (k: Phase["kind"], text: string) => setPhase({ kind: k, text });
  const failed = (word: string) => say("err", refused(word, { who: name, target: f.machine, ...(kind === "move" ? { from: here } : {}) }));

  /** Слот копии в новой папке: нынешний; нет — первый, если их несколько; один — решает машина. Список не пришёл — сессию не трогаем. */
  async function slotOfCopy(): Promise<{ slot?: string } | null> {
    const own = slotOf(sessionOf(app, callsign))?.name;
    if (own) return { slot: own };
    const r = await app.read<{ slots: Record<string, unknown> }>("machine.accounts", { machine: f.machine });
    if (!r.ok) {
      say("err", `machine.accounts: ${r.error}`);
      return null;
    }
    const slot = slotChoice(Object.keys(r.result.slots));
    return slot ? { slot } : {};
  }

  /** Свежая точка: перенос, откат и смена папки — со стопом, копия — без. */
  async function save(): Promise<number | null> {
    say("run", kind === "copy" ? `${here} кладёт свежую точку…` : `${here} дожидается конца ответа, останавливает сессию и кладёт точку…`);
    const r = await app.request<{ point: number }>("points.save", { callsign, ...(kind === "copy" ? {} : { stop: true, ...(f.cut ? { interrupt: true } : {}) }) });
    if (r.ok) return r.result.point;
    failed(r.error);
    return null;
  }

  async function forget(raised: string) {
    say("run", `«Забыть» ${callsign}…`);
    const gone = await app.request("session.remove", { callsign });
    if (gone.ok) say("done", `Копия в новой папке: ${raised}; ${callsign} забыта, её точки остались в R2.`);
    else failed(gone.error);
  }

  function finish(point: number, r: Raised) {
    if (kind === "move") say("done", `${name} перенесена на ${f.machine}: ${r.callsign}. ${here} её отпустил.`);
    if (kind === "copy") say("done", `Копия поднята: ${r.callsign}. Исходная сессия не менялась.`);
    if (kind === "rb") say("done", `Откат: ${callsign} поднята из точки №${point}; нынешнее — веткой «до отката»${r.branch ? `, папка на ветке git ${r.branch}` : ""}. Новая ссылка claude.ai придёт в roster.`);
  }

  async function run() {
    const slot = kind === "dir" ? await slotOfCopy() : kind === "rb" || !f.slot ? {} : { slot: f.slot };
    if (!slot) return;
    const saved = kind === "copy" && f.point ? f.point.id : await save();
    if (saved === null) return;
    const point = kind === "rb" ? from!.id : saved;
    say("run", `${f.machine} поднимает сессию из точки №${point}…`);
    const copy = kind === "copy" || kind === "dir" ? { copy: true, name: f.name } : {};
    const r = await app.request<Raised>("points.raise", { machine: f.machine, sid, point, dir: f.dir, files: f.files, ...copy, ...slot });
    changed();
    if (!r.ok) return kind === "dir" ? say("err", `Копия не поднялась — «Забыть» не отправлен, ${callsign} остаётся остановленной`) : failed(r.error);
    joinProject(app, callsign, r.result.callsign);
    if (kind === "dir") return forget(r.result.callsign);
    finish(point, r.result);
  }

  return { phase, run };
}

const FromRow = ({ point, now }: { point: ListedPoint | null; now(): void }) => (
  <Row label="Из точки">
    <Opts>
      {point ? <Btn aria-pressed="true">{`№${point.id}`}</Btn> : null}
      <Btn aria-pressed={!point} onClick={now}>
        сейчас — сохранится свежая
      </Btn>
    </Opts>
  </Row>
);

const SameMachine = ({ here }: { here: string }) => (
  <Row label="Машина">
    <span>{`${here} — та же`}</span>
  </Row>
);

function RollbackFolder({ dir, files, set }: { dir: string; files: "keep" | "point"; set(f: "keep" | "point"): void }) {
  return (
    <>
      <Row label="Папка">
        <M>{dir}</M>
      </Row>
      <Opts>
        <Btn aria-pressed={files === "keep"} onClick={() => set("keep")}>
          Оставить как есть
        </Btn>
        <Btn aria-pressed={files === "point"} onClick={() => set("point")}>
          Вернуть к папке точки
        </Btn>
      </Opts>
    </>
  );
}

const NameRow = ({ label, value, at, set }: { label: string; value: string; at: string; set(v: string): void }) => (
  <Row label={label}>
    <Opts>
      <In mono data-f="name" value={value} onInput={(e) => set(e.currentTarget.value)} />
      <Note>{`→ ${value}@${at}`}</Note>
    </Opts>
  </Row>
);

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

const defaults = (kind: Kind, name: string, dir: string) => (kind === "copy" ? { name: `${name}-copy`, dir: `${dir}-copy` } : kind === "dir" ? { name: `${name}-v2`, dir: `${dir}-v2` } : { name: `${name}-v2`, dir });

export function Dialog(p: Props) {
  const { kind, callsign, sid, head, from, close } = p;
  const app = useApp();
  const [name, here] = callsign.split("@");
  const session = sessionOf(app, callsign);
  const moving = kind === "move" || kind === "copy";
  const t = useTarget({ owner: here, near: [...nearOf(app, callsign), here], slot: slotOf(session)?.name });
  const machine = moving ? t.machine : here;
  const start = defaults(kind, name, from?.dir ?? head.dir ?? "~");
  const [newName, setName] = useState(start.name);
  const [dir, setDir] = useState(start.dir);
  const [point, setPoint] = useState(from);
  const [back, setBack] = useState<"keep" | "point">("keep");
  const [cut, setCut] = useState(false);
  const files = moving ? "point" : kind === "dir" ? "keep" : back;
  const { phase, run } = useSteps(p, { machine, slot: t.slot, dir, name: newName, point, files, cut });
  const check = useProbe(machine, moving && t.slots && !t.problem ? { sid, point: (point ?? head).id, dir, files: "point" } : null);
  const problem = moving ? t.problem : "";
  const done = phase?.kind === "done";
  const label = { move: `Перенести на ${machine}`, copy: `Скопировать на ${machine}`, dir: "Скопировать и забыть", rb: `Откатить к №${(point ?? head).id}` }[kind];
  return (
    <Sec dlg data-dlg={kind}>
      <H4>{TITLES[kind](callsign, (point ?? head).id)}</H4>
      {moving ? <Machines t={t} /> : <SameMachine here={here} />}
      {moving ? <FromRow point={point} now={() => setPoint(null)} /> : null}
      {moving ? <Slot t={t} label={`Слот на ${machine}`} /> : null}
      {kind === "rb" ? (
        <RollbackFolder dir={dir} files={back} set={setBack} />
      ) : (
        <Row label={kind === "dir" ? "Новая папка" : `Папка на ${machine}`}>
          <CommitIn mono data-f="dir" value={dir} onCommit={setDir} />
        </Row>
      )}
      {kind === "copy" || kind === "dir" ? <NameRow label={kind === "copy" ? "Имя копии" : "Имя"} value={newName} at={machine} set={setName} /> : null}
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
          <Btn pri data-act="run" disabled={phase?.kind === "run" || !!problem || (moving && blocked(check))} onClick={() => void run()}>
            {label}
          </Btn>
        )}
      </Opts>
    </Sec>
  );
}
