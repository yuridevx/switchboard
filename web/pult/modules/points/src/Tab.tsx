// Вкладка «Точки» карточки: пометка «в R2», линия и ветки, карточка точки, окна.
import { Fragment, useEffect, useState } from "react";
import { ago, Btn, Check, day, H4, hhmm, In, Note, Opts, OptsLabel, Outcome, type OutcomeNote, Page, PageHead, Row, RowBtn, Sec, sessionOf, useApp, useLoad, useModule } from "@switchboard/web-ui";
import type { ScreenProps } from "@switchboard/web-core";
import type { ListedPoint, Point, PointsListSession } from "@switchboard/points";
import { Dialog, type Kind } from "./Dialog.tsx";
import type { Fleet } from "./store.ts";
import { countOf, megabytes, refused } from "./words.ts";

type Words = Record<number, string[][] | undefined>;

function gitLine(git: { state?: string; files?: number; branch?: string } | undefined) {
  if (!git) return "";
  const n = git.files ?? 0;
  const state = git.state === "dirty" ? `${countOf(n, "файл", "файла", "файлов")} ${n % 10 === 1 && n % 100 !== 11 ? "не закоммичен" : "не закоммичено"}` : "чисто";
  return `git: ${state}${git.branch ? ` · ${git.branch}` : ""}`;
}

function PointCard({ p, head, words, act }: { p: ListedPoint; head: boolean; words?: string[][]; act?: { copy?(): void; back?(): void } }) {
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
          <span>{countOf(p.msgs, "сообщение", "сообщения", "сообщений")}</span>
        </Row>
      )}
      <Row label="с машины">
        <span>{p.machine}</span>
      </Row>
      {p.git ? (
        <Row label="папка">
          <span>{gitLine(p.git as never)}</span>
        </Row>
      ) : null}
      <Row label="срок">
        <span>{p.until === null ? "хранится, пока есть сессия" : `хранится до ${day(p.until)} ${new Date(p.until).getFullYear()}`}</span>
      </Row>
      {words?.length ? <Note>{words.map(([q, a]) => `${q} → ${a}`).join(" · ")}</Note> : null}
      <Opts>
        {act?.copy ? <Btn onClick={act.copy}>Скопировать из этой точки…</Btn> : null}
        {act?.back && !head ? (
          <Btn data-act="rb" onClick={act.back}>
            Откатить к этой точке…
          </Btn>
        ) : null}
      </Opts>
    </Sec>
  );
}

function Unmark({ callsign, go, close }: { callsign: string; go(): void; close(): void }) {
  const [name, machine] = callsign.split("@");
  const [typed, setTyped] = useState("");
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
        <Btn bad data-act="unmark" disabled={typed !== name} onClick={go}>
          Убрать из R2
        </Btn>
      </Opts>
    </Sec>
  );
}

type Noted = { callsign: string; note: OutcomeNote | null; say(text: string, tone?: OutcomeNote["tone"]): void };

function Marked({ callsign, note, say }: Noted) {
  const app = useApp();
  const fleet = useModule<Fleet>();
  const [name, machine] = callsign.split("@");
  const sid = app.use(() => fleet.sidOf(callsign)?.sid);
  const fleetError = app.use(() => fleet.get().error);
  // сессию только что пометили: обзор узнает её номер в реестре
  useEffect(() => void (sid || fleet.read()), [sid, fleet]);
  const line = useLoad<PointsListSession>(() => (sid ? app.read<PointsListSession>("points.list", { sid }) : Promise.resolve({ ok: true, result: { owner: null, head: null, points: [] } })), [sid]);
  const points = (line.data?.points ?? []) as ListedPoint[];
  const ids = points.map((p) => p.id);
  const words = useLoad<{ points: Array<Pick<Point, "id" | "last">> }>(() => (ids.length ? app.read("points.get", { ids }) : Promise.resolve({ ok: true, result: { points: [] } })), [ids.join()]);
  const last: Words = Object.fromEntries((words.data?.points ?? []).map((p) => [p.id, p.last as string[][] | undefined]));
  const failed = app.use(() => (sessionOf(app, callsign)?.r2 as { error?: string } | undefined)?.error);
  const canSave = app.use(() => app.can(machine, "points.save") === true);
  const canRaise = app.use(() => app.can(machine, "points.raise") === true);
  const [card, setCard] = useState<number | null>(null);
  const [dialog, setDialog] = useState<{ kind: Kind; from: ListedPoint | null } | null>(null);
  const [unmark, setUnmark] = useState(0);
  const head = points.find((p) => p.id === line.data?.head) ?? points[0];
  const word = line.error || (sid ? "" : fleetError);
  const title = word ? `points.list: ${word}` : head ? `Точка ${ago(head.at)} · №${head.id}${head.bytes ? ` · ${megabytes(head.bytes)}` : ""}` : line.loading ? "…" : "Точек ещё нет";
  const open = (kind: Kind, from: ListedPoint | null = null) => setDialog({ kind, from });
  const changed = () => {
    line.reload();
    void fleet.read();
  };

  const save = async () => {
    say("Сохраняю точку…");
    const r = await app.request<{ point: number; same: boolean }>("points.save", { callsign });
    if (r.ok) say(r.result.same ? `Точка №${r.result.point} — та же, файлы не менялись` : `Точка №${r.result.point}`, "ok");
    else say(refused(r.error, { who: name }), "bad");
    changed();
  };

  const off = async () => {
    say("Удаляю точки…");
    const r = await app.request<{ deleted: number }>("session.r2", { callsign, on: false });
    if (!r.ok) return say(refused(r.error, { who: name }), "bad");
    say(`${countOf(r.result.deleted, "точка", "точки", "точек")} ${r.result.deleted % 10 === 1 && r.result.deleted % 100 !== 11 ? "удалена" : "удалено"} из R2 — сразу, без отмены. Сессия на ${machine} работает дальше, без точек.`, "ok");
    setUnmark(0);
    void fleet.read();
  };

  const days = [...new Set(points.map((p) => day(p.at)))];
  return (
    <Page>
      <Sec data-r2="on">
        <PageHead>
          <b>{title}</b>
          {canSave ? <Btn onClick={() => void save()}>Сохранить точку</Btn> : null}
          {canRaise ? (
            <>
              <Btn disabled={!head} onClick={() => open("move")}>
                Перенести…
              </Btn>
              <Btn disabled={!head} onClick={() => open("copy")}>
                Скопировать…
              </Btn>
              <Btn data-act="dir" disabled={!head} onClick={() => open("dir")}>
                Сменить папку…
              </Btn>
            </>
          ) : null}
        </PageHead>
        {failed ? <Note tone="bad">{`последняя точка не удалась: ${failed}`}</Note> : null}
        {words.error ? <Note tone="bad">{`points.get: ${words.error}`}</Note> : null}
        <Outcome data-note="" note={note} />
      </Sec>
      {dialog && sid && head ? <Dialog key={`${dialog.kind}:${dialog.from?.id}`} kind={dialog.kind} callsign={callsign} sid={sid} head={head} from={dialog.from} close={() => setDialog(null)} changed={changed} /> : null}
      {points.length ? (
        <Sec data-points="">
        <H4>Линия и ветки</H4>
        {days.map((d) => (
          <Fragment key={d}>
            <div className="pt-day">{d}</div>
            {points
              .filter((p) => day(p.at) === d)
              .map((p) => (
                <Fragment key={p.id}>
                  <RowBtn className={p.line ? "pt-pt" : "pt-pt br"} data-point={p.id} aria-pressed={card === p.id} onClick={() => setCard(card === p.id ? null : p.id)}>
                    <span>{hhmm(p.at)}</span>
                    <i />
                    <span>{last[p.id]?.[0] ? `«${last[p.id]![0][0]}»` : p.why}</span>
                    <em>{p.line ? `№${p.id}` : `ветка · №${p.id}`}</em>
                  </RowBtn>
                  {card === p.id ? <PointCard p={p} head={p.id === head?.id} words={last[p.id]} act={canRaise ? { copy: () => open("copy", p), back: () => open("rb", p) } : undefined} /> : null}
                </Fragment>
              ))}
          </Fragment>
        ))}
        </Sec>
      ) : null}
      <Sec>
        <OptsLabel>
          <Check checked data-act="r2" onChange={() => setUnmark((n) => n + 1)} />
          Хранить в R2
        </OptsLabel>
        <Note>Снять — точки сессии удалятся из R2 сразу, без отмены.</Note>
      </Sec>
      {unmark ? <Unmark key={unmark} callsign={callsign} go={() => void off()} close={() => setUnmark(0)} /> : null}
    </Page>
  );
}

function Unmarked({ callsign, note, say }: Noted) {
  const app = useApp();
  const fleet = useModule<Fleet>();
  const [on, setOn] = useState(false);
  const mark = async () => {
    setOn(true);
    say("Включаю…");
    const r = await app.request<{ point: number | null }>("session.r2", { callsign, on: true });
    setOn(r.ok);
    if (!r.ok) return say(refused(r.error), "bad");
    say(r.result.point === null ? "Первая точка — на первом конце хода." : `Первая точка — №${r.result.point}, только что; дальше Host кладёт их сам.`, "ok");
    void fleet.read();
  };
  return (
    <Page>
      <Sec data-r2="off">
        <b>{`${callsign} не в R2`}</b>
        <OptsLabel>
          <Check checked={on} data-act="r2" onChange={() => void mark()} />
          Хранить в R2
        </OptsLabel>
        <Outcome data-note="" note={note} />
      </Sec>
    </Page>
  );
}

export function Tab({ params }: ScreenProps) {
  const app = useApp();
  const callsign = params.callsign;
  const marked = app.use(() => sessionOf(app, callsign)?.r2 !== undefined);
  const [note, setNote] = useState<OutcomeNote | null>(null);
  const say: Noted["say"] = (text, tone) => setNote({ text, tone });
  return marked ? <Marked callsign={callsign} note={note} say={say} /> : <Unmarked callsign={callsign} note={note} say={say} />;
}
