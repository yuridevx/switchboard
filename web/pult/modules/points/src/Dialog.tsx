// Окна действий сессии: перенос, копия и откат — из выбранной точки (последняя — из свежей), смена папки; шаги по порядку,
// каждый запрос после ответа предыдущего. Дошло — done: окно закрывается, итог строкой на странице.
import { useState } from "react";
import { machineOf, nameOf } from "@switchboard/protocol";
import { Btn, Check, CommitIn, H4, In, Note, OptsLabel, Opts, remoteOf, Row, Sec, sessionOf, slotChoice, slotOf, useApp } from "@switchboard/web-ui";
import type { ListedPoint } from "@switchboard/points";
import { CheckLine } from "./windows.tsx";
import { joinProject, Machines, Slot, useProbe, useTarget, type Target } from "./target.tsx";
import { blocked, refused } from "./words.ts";

export type Kind = "move" | "copy" | "dir" | "rb";

type Props = { kind: Kind; callsign: string; sid: string; head: ListedPoint; from: ListedPoint | null; close(): void; changed(): void; done(text: string, link?: string): void };
type Phase = { kind: "run" | "err" | "done"; text: string };
/** Что выбрано в окне к запуску. */
type Form = { machine: string; slot: string; dir: string; name: string; files: "keep" | "point"; cut: boolean; point: ListedPoint | null };
type Raised = { callsign: string; branch?: string | null };

/** Заголовок окна — то же действие, что на кнопке, и точка: последняя — «свежая точка». */
const TITLES: Record<Kind, (callsign: string, point: number | null) => string> = {
  move: (c, p) => `Перенести на машину ${c} — ${p ? `из №${p}` : "из свежей точки"}`,
  copy: (c, p) => `Копия ${c} — ${p ? `из №${p}` : "из свежей точки"}`,
  dir: (c) => `Сменить папку ${c}`,
  rb: (c, p) => `Откатить ${c} к №${p}`,
};

/** Шаги окна: слот копии → свежая точка → подъём → «Забыть» прежней. */
function useSteps({ kind, callsign, sid, from, changed, done }: Props, f: Form) {
  const app = useApp();
  const name = nameOf(callsign);
  const here = machineOf(callsign)!;
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
    if (gone.ok) done(`Копия в новой папке, ${callsign} забыта:`, raised);
    else failed(gone.error);
  }

  function finish(point: number, r: Raised) {
    if (kind === "move") done(`${name} перенесена на ${f.machine}:`, r.callsign);
    if (kind === "copy") done("Копия поднята:", r.callsign);
    if (kind === "rb") done(`Откат к №${point}, прежнее — веткой${r.branch ? ` и веткой git ${r.branch}` : ""}.`);
  }

  async function run() {
    const slot = kind === "dir" ? await slotOfCopy() : kind === "rb" || !f.slot ? {} : { slot: f.slot };
    if (!slot) return;
    const saved = kind === "copy" && f.point ? f.point.id : await save();
    if (saved === null) return;
    const point = (kind === "rb" || kind === "move") && from ? from.id : saved;
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

const SameMachine = ({ here }: { here: string }) => (
  <Row label="Машина">
    <span>{`${here} — та же`}</span>
  </Row>
);

function RollbackFiles({ files, set }: { files: "keep" | "point"; set(f: "keep" | "point"): void }) {
  return (
    <Row label="Файлы">
      <Opts>
        <Btn aria-pressed={files === "keep"} onClick={() => set("keep")}>
          как сейчас
        </Btn>
        <Btn aria-pressed={files === "point"} onClick={() => set("point")}>
          как в точке
        </Btn>
      </Opts>
    </Row>
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

const labelOf = (kind: Kind, machine: string, point: number) => ({ move: `Перенести на ${machine}`, copy: `Скопировать на ${machine}`, dir: "Скопировать и забыть", rb: `Откатить к №${point}` })[kind];

const Where = ({ t }: { t: Target }) => (
  <>
    <Machines t={t} />
    <Slot t={t} label={`Слот на ${t.machine}`} />
  </>
);

function CutBox({ kind, cut, set }: { kind: Kind; cut: boolean; set(on: boolean): void }) {
  if (kind === "copy") return null;
  return (
    <OptsLabel>
      <Check checked={cut} onChange={(e) => set(e.currentTarget.checked)} />
      прервать идущий ответ
    </OptsLabel>
  );
}

const DirRow = ({ label, dir, set }: { label: string; dir: string; set(d: string): void }) => (
  <Row label={label}>
    <CommitIn mono data-f="dir" value={dir} onCommit={set} />
  </Row>
);

const Buttons = ({ can, label, run, close }: { can: boolean; label: string; run(): void; close(): void }) => (
  <Opts>
    <Btn onClick={close}>Отмена</Btn>
    <Btn pri data-act="run" disabled={!can} onClick={run}>
      {label}
    </Btn>
  </Opts>
);

export function Dialog(p: Props) {
  const { kind, callsign, sid, head, from, close } = p;
  const app = useApp();
  const name = nameOf(callsign);
  const here = machineOf(callsign)!;
  const session = sessionOf(app, callsign);
  const moving = kind === "move" || kind === "copy";
  const t = useTarget({ owner: here, slot: slotOf(session)?.name });
  const machine = moving ? t.machine : here;
  const start = defaults(kind, name, from?.dir ?? head.dir ?? "~");
  const [newName, setName] = useState(start.name);
  const [dir, setDir] = useState(start.dir);
  const [back, setBack] = useState<"keep" | "point">("keep");
  const [cut, setCut] = useState(false);
  const shown = from ?? head;
  const { phase, run } = useSteps(p, { machine, slot: t.slot, dir, name: newName, files: moving ? "point" : kind === "dir" ? "keep" : back, cut, point: from });
  const check = useProbe(machine, moving && t.slots && !t.problem ? { sid, point: shown.id, dir, files: "point" } : null);
  const problem = moving ? t.problem : "";
  const can = phase?.kind !== "run" && !problem && (!moving || !blocked(check));
  return (
    <Sec dlg data-dlg={kind}>
      <H4>{TITLES[kind](callsign, from?.id ?? null)}</H4>
      {moving ? <Where t={t} /> : kind === "rb" ? null : <SameMachine here={here} />}
      {kind === "rb" ? <RollbackFiles files={back} set={setBack} /> : <DirRow label={kind === "dir" ? "Новая папка" : `Папка на ${machine}`} dir={dir} set={setDir} />}
      {kind === "copy" || kind === "dir" ? <NameRow label={kind === "copy" ? "Имя копии" : "Имя"} value={newName} at={machine} set={setName} /> : null}
      <CheckLine check={problem ? { key: "error", text: problem, tone: "bad" } : check} />
      {kind === "rb" && remoteOf(session) ? <RemoteWarning /> : null}
      <CutBox kind={kind} cut={cut} set={setCut} />
      {phase ? <PhaseLine phase={phase} /> : null}
      <Buttons can={can} label={labelOf(kind, machine, shown.id)} run={() => void run()} close={close} />
    </Sec>
  );
}
