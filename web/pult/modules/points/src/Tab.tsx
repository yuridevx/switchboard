// Вкладка «Точки» карточки сессии: пометка «в R2», линия и ветки, карточка точки, окна действий.
import { machineOf, nameOf } from "@switchboard/protocol";
import { Fragment, useEffect, useState } from "react";
import { type ScreenProps } from "@switchboard/web-core";
import { ago, Btn, Check, day, H4, hhmm, In, Note, Opts, OptsLabel, type OutcomeNote, Page, PageHead, plural, Row, RowBtn, Sec, sessionOf, Outcome, useApp, useLoad, useModule } from "@switchboard/web-ui";
import { PointDialog, type Kind } from "./PointDialog.tsx";
import type { PointsStore } from "./store.ts";
import { mb, points as pointsText, wordText } from "./words.ts";

export type LinePoint = { id: number; at: number; machine: string; why: string; base: number | null; dir?: string; msgs?: number; bytes?: number; git?: { state?: string; files?: number; branch?: string }; line: boolean; until: number | null };
type Line = { owner: string | null; head: number | null; points?: LinePoint[] };
type Words = { owner: string; points: Array<{ id: number; last?: string[][] }> };

const gitText = (g: NonNullable<LinePoint["git"]>) => {
  const n = g.files ?? 0;
  const state = g.state === "dirty" ? `${n} ${n === 1 ? "файл не закоммичен" : `${plural(n, "файл", "файла", "файлов")} не закоммичено`}` : "чисто";
  return `git: ${state}${g.branch ? ` · ${g.branch}` : ""}`;
};

function PointCard({ p, last, head, act }: { p: LinePoint; last?: string[][]; head: boolean; act: { raise: boolean; open(kind: Kind, from: LinePoint): void } }) {
  return (
    <Sec data-card={p.id}>
      <Row label="когда">
        <span>{`${day(p.at)} ${hhmm(p.at)} · №${p.id}${head ? " · последняя" : ""}`}</span>
      </Row>
      <Row label="почему">
        <span>{p.why}</span>
      </Row>
      {p.msgs === undefined ? null : (
        <Row label="разговор">
          <span>{`${p.msgs} ${plural(p.msgs, "сообщение", "сообщения", "сообщений")}`}</span>
        </Row>
      )}
      <Row label="с машины">
        <span>{p.machine}</span>
      </Row>
      {p.git ? (
        <Row label="папка">
          <span>{gitText(p.git)}</span>
        </Row>
      ) : null}
      <Row label="срок">
        <span>{p.until === null ? "хранится, пока есть сессия" : `хранится до ${day(p.until)} ${new Date(p.until).getFullYear()}`}</span>
      </Row>
      {last?.length ? <Note>{last.map(([q, a]) => `${q} → ${a}`).join(" · ")}</Note> : null}
      {act.raise ? (
        <Opts>
          <Btn onClick={() => act.open("copy", p)}>Скопировать из этой точки…</Btn>
          {head ? null : (
            <Btn data-act="rb" onClick={() => act.open("rb", p)}>
              Откатить к этой точке…
            </Btn>
          )}
        </Opts>
      ) : null}
    </Sec>
  );
}

function PointsLine({ line, words, opened, pick, card }: { line: LinePoint[]; words: Map<number, string[][]>; opened: number | null; pick(id: number | null): void; card(p: LinePoint): React.ReactNode }) {
  const days = new Map<string, LinePoint[]>();
  for (const p of line) days.set(day(p.at), [...(days.get(day(p.at)) ?? []), p]);
  return (
    <Sec data-points="">
      <H4>Линия и ветки</H4>
      {[...days].map(([name, rows]) => (
        <Fragment key={name}>
          <div className="pt-day">{name}</div>
          {rows.map((p) => {
            const first = words.get(p.id)?.[0]?.[0];
            return (
              <Fragment key={p.id}>
                <RowBtn aria-pressed={opened === p.id ? "true" : "false"} data-point={p.id} className={p.line ? "pt-pt" : "pt-pt br"} onClick={() => pick(opened === p.id ? null : p.id)}>
                  <span>{hhmm(p.at)}</span>
                  <i />
                  <span>{first ? `«${first}»` : p.why}</span>
                  <em>{`${p.line ? "" : "ветка · "}№${p.id}`}</em>
                </RowBtn>
                {opened === p.id ? card(p) : null}
              </Fragment>
            );
          })}
        </Fragment>
      ))}
    </Sec>
  );
}

function Unmark({ callsign, close, note }: { callsign: string; close(): void; note(n: OutcomeNote): void }) {
  const app = useApp();
  const name = nameOf(callsign);
  const machine = machineOf(callsign);
  const [typed, setTyped] = useState("");

  async function go(): Promise<void> {
    note({ text: "Удаляю точки…" });
    const r = await app.request<{ deleted: number }>("session.r2", { callsign, on: false });
    if (!r.ok) return note({ text: wordText(r.error, { name }), tone: "bad" });
    const n = r.result.deleted;
    note({ text: `${pointsText(n)} ${n === 1 ? "удалена" : "удалено"} из R2 — сразу, без отмены. Сессия на ${machine} работает дальше, без точек.`, tone: "ok" });
    close();
  }

  return (
    <Sec dlg data-dlg="unmark">
      <b>{`Убрать ${callsign} из R2`}</b>
      <Note>{`Точки и ветки сессии удалятся из R2 сразу; отменить нельзя. Сессия на ${machine} продолжит работу — без точек и переноса.`}</Note>
      <Opts>
        <span>{`Введите имя сессии: ${name}`}</span>
        <In mono data-f="unmark" placeholder={name} value={typed} onInput={(e) => setTyped(e.currentTarget.value)} />
      </Opts>
      <Opts>
        <Btn onClick={close}>Отмена</Btn>
        <Btn bad data-act="unmark" disabled={typed !== name} onClick={() => void go()}>
          Убрать из R2
        </Btn>
      </Opts>
    </Sec>
  );
}

function Marked({ callsign, note, setNote }: { callsign: string; note: OutcomeNote | null; setNote(n: OutcomeNote): void }) {
  const app = useApp();
  const store = useModule<PointsStore>();
  const machine = machineOf(callsign) ?? "";
  const name = nameOf(callsign);
  const sid = app.use(() => store.get().fleet?.sessions.find((x) => x.callsign === callsign)?.sid);
  const fleetError = app.use(() => store.get().error);
  const lastError = app.use(() => (sessionOf(app, callsign)?.r2 as { error?: string } | undefined)?.error);
  const canSave = app.use(() => app.can(machine, "points.save") === true);
  const canRaise = app.use(() => app.can(machine, "points.raise") === true);
  const near = app.use(() => {
    const project = app.mark("project.of", callsign) as { id: string } | null | undefined;
    return project ? ((app.mark("project.machines", project.id) as string[] | undefined) ?? []) : [];
  });

  const line = useLoad<Line>(() => (sid ? app.read<Line>("points.list", { sid }) : Promise.resolve({ ok: true, result: { owner: null, head: null, points: [] } })), [sid]);
  const rows = line.data?.points ?? [];
  const ids = rows.map((p) => p.id);
  const words = useLoad<Words>(() => (ids.length ? app.read<Words>("points.get", { ids }) : Promise.resolve({ ok: true, result: { owner: "", points: [] } })), [ids.join()]);
  const firstWords = new Map((words.data?.points ?? []).map((p) => [p.id, p.last ?? []]));

  const [opened, setOpened] = useState<number | null>(null);
  const [dialog, setDialog] = useState<{ kind: Kind; from?: LinePoint } | null>(null);
  const [unmarking, setUnmarking] = useState(false);

  // сессию только что пометили: обзор узнает её номер в реестре
  useEffect(() => {
    if (!sid) void store.read();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store]);
  const changed = () => {
    line.reload();
    void store.read();
  };

  async function save(): Promise<void> {
    setNote({ text: "Сохраняю точку…" });
    const r = await app.request<{ point: number; same?: boolean }>("points.save", { callsign });
    setNote(r.ok ? { text: r.result.same ? `Точка №${r.result.point} — та же, файлы не менялись` : `Точка №${r.result.point}`, tone: "ok" } : { text: wordText(r.error, { name }), tone: "bad" });
    changed();
  }

  const head = rows.find((p) => p.id === line.data?.head) ?? rows[0];
  const listError = line.error || (!sid ? fleetError : "");
  const title = listError ? `points.list: ${listError}` : !head ? (line.loading ? "…" : "Точек ещё нет") : `Точка ${ago(head.at)} · №${head.id}${head.bytes ? ` · ${mb(head.bytes)} МБ` : ""}`;

  return (
    <Page>
      <Sec data-r2="on">
        <PageHead>
          <b>{title}</b>
          {canSave ? <Btn onClick={() => void save()}>Сохранить точку</Btn> : null}
          {canRaise ? (
            <>
              <Btn disabled={!head} onClick={() => setDialog({ kind: "move" })}>
                Перенести…
              </Btn>
              <Btn disabled={!head} onClick={() => setDialog({ kind: "copy" })}>
                Скопировать…
              </Btn>
              <Btn data-act="dir" disabled={!head} onClick={() => setDialog({ kind: "dir" })}>
                Сменить папку…
              </Btn>
            </>
          ) : null}
        </PageHead>
        {lastError ? <Note tone="bad">{`последняя точка не удалась: ${lastError}`}</Note> : null}
        {words.error ? <Note tone="bad">{`points.get: ${words.error}`}</Note> : null}
        <Outcome data-note="" note={note} />
      </Sec>
      {dialog && sid ? <PointDialog key={`${dialog.kind}:${dialog.from?.id ?? ""}`} kind={dialog.kind} callsign={callsign} sid={sid} head={head} from={dialog.from} near={near} changed={changed} close={() => setDialog(null)} /> : null}
      {rows.length ? (
        <PointsLine line={rows} words={firstWords} opened={opened} pick={setOpened} card={(p) => <PointCard p={p} last={firstWords.get(p.id)} head={p.id === head?.id} act={{ raise: canRaise, open: (kind, from) => setDialog({ kind, from }) }} />} />
      ) : null}
      <Sec>
        <OptsLabel>
          <Check data-act="r2" checked onChange={() => setUnmarking(true)} />
          Хранить в R2
        </OptsLabel>
        <Note>Снять — точки сессии удалятся из R2 сразу, без отмены.</Note>
        {unmarking ? <Unmark callsign={callsign} close={() => setUnmarking(false)} note={setNote} /> : null}
      </Sec>
    </Page>
  );
}

function NotMarked({ callsign, note, setNote }: { callsign: string; note: OutcomeNote | null; setNote(n: OutcomeNote): void }) {
  const app = useApp();

  async function on(): Promise<void> {
    setNote({ text: "Включаю…" });
    const r = await app.request<{ point: number | null }>("session.r2", { callsign, on: true });
    if (!r.ok) return setNote({ text: wordText(r.error, { name: nameOf(callsign) }), tone: "bad" });
    setNote({ text: r.result.point === null ? "Первая точка — на первом конце хода." : `Первая точка — №${r.result.point}, только что; дальше Host кладёт их сам.`, tone: "ok" });
  }

  return (
    <Page>
      <Sec data-r2="off">
        <b>{`${callsign} не в R2`}</b>
        <OptsLabel>
          <Check data-act="r2" checked={false} onChange={() => void on()} />
          Хранить в R2
        </OptsLabel>
        <Outcome data-note="" note={note} />
      </Sec>
    </Page>
  );
}

export function Tab({ params }: ScreenProps) {
  const app = useApp();
  const callsign = params.callsign ?? "";
  const r2 = app.use(() => sessionOf(app, callsign)?.r2 !== undefined);
  const [note, setNote] = useState<OutcomeNote | null>(null);
  return r2 ? <Marked callsign={callsign} note={note} setNote={setNote} /> : <NotMarked callsign={callsign} note={note} setNote={setNote} />;
}
