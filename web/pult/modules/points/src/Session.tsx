// Страница сессии архива: шапка (title, callsign — ссылка в карточку живой, проект, модель, токены), разговор — лента web-chat
// (chat.view) с точками на своих местах: клик по точке выбирает её, разговор после неё приглушён; выбранная точка — в адресе.
// Справа линия точек: выбранная раскрывается прямо в линии — действия, их окна, «На свой компьютер» и вызовы модели.
// Вкладка «Архив» карточки — только линия точек и «Хранить в архиве»: разговор у карточки свой. На телефоне — вкладки.
import { Fragment, useEffect, useState, type ReactNode } from "react";
import { machineOf, nameOf } from "@switchboard/protocol";
import { Btn, Check, Cmd, CopyButton, day, H4, hhmm, In, M, machinesWith, Note, Opts, OptsLabel, Outcome, Page, Pill, RowBtn, Sec, sessionOf, Tabs, TextBtn, useApp, useLoad, useModule, type OutcomeNote } from "@switchboard/web-ui";
import type { ListedPoint } from "@switchboard/points";
import { Dialog, type Kind } from "./Dialog.tsx";
import { modelName, tok, titleOf, tokens, type Call, type Fleet, type Line, type Listed } from "./store.ts";
import { DeleteWindow, RaiseWindow } from "./windows.tsx";
import { countOf, refused } from "./words.ts";

const WHY: Record<string, string> = { start: "старт Host", rule: "конец хода", save: "сохранена вручную", raise: "подъём", yield: "сессия ушла" };
type Pane = "talk" | "points";
const PANES = [
  ["talk", "Разговор"],
  ["points", "Точки"],
] as const satisfies ReadonlyArray<readonly [Pane, string]>;
type Open = { kind: Kind | "raise" | "delete"; n: number } | null;
/** Итог действия: текст и, если есть, сессия-результат ссылкой в её карточку. */
type Done = { text: string; link?: string } | undefined;

function gitLine(git: { state?: string; files?: number; branch?: string } | undefined) {
  if (!git) return "";
  const n = git.files ?? 0;
  return `${git.state === "dirty" ? `git: ${countOf(n, "файл", "файла", "файлов")} не в коммите` : "git чисто"}${git.branch ? ` · ${git.branch}` : ""}`;
}

/** Команда на свой компьютер: пропуск устройства человека, файлы — в ~/.claude/projects и рабочую папку. */
function Pull({ callsign, sid, point, head }: { callsign?: string; sid: string; point: number; head: boolean }) {
  const cmd = `switchboard pull ${callsign ?? sid}${head ? "" : ` --point ${point}`}`;
  return (
    <div className="ss-pull" data-pull={point}>
      <Cmd>
        {cmd.split(" ").map((w, i) => (
          <Fragment key={i}>
            {i ? " " : ""}
            <span>{w}</span>
          </Fragment>
        ))}
      </Cmd>
      <CopyButton text={cmd} label="Копировать" />
    </div>
  );
}

function Calls({ sid, point }: { sid: string; point: number }) {
  const app = useApp();
  const r = useLoad(() => app.read<{ calls: Call[] }>("points.history", { sid, point, before: null, limit: 1 }), [sid, point]);
  const [all, setAll] = useState(false);
  const calls = [...(r.data?.calls ?? [])].reverse();
  if (r.error) return <Note tone="bad">{`Вызовы не загрузились: ${refused(r.error)}`}</Note>;
  if (!calls.length) return null;
  const shown = all ? calls : calls.slice(0, 4);
  return (
    <div className="ss-calls" data-calls={point}>
      <H4>Вызовы модели</H4>
      {shown.map((c) => (
        <div key={c.uuid} className="ss-call" data-call={c.uuid}>
          <span className="ss-when">{hhmm(new Date(c.at))}</span>
          <span className="ss-model">{modelName(c.model)}</span>
          <span className="ss-num">{`${tok(c.tok_in)} → ${tok(c.tok_out)}`}</span>
          <TextBtn data-f="test-rules" onClick={() => app.open("settings", { tab: "rules", call: `${sid}/${c.uuid}` })}>
            Правила
          </TextBtn>
        </div>
      ))}
      {calls.length > shown.length ? <TextBtn onClick={() => setAll(true)}>{`ещё ${calls.length - shown.length}`}</TextBtn> : null}
    </div>
  );
}

/** Выбранная точка в линии: что это за точка, действия с ней, окно нажатого действия, команда pull и вызовы модели. */
function PointBody({ p, head, live, s, open, act, form }: { p: ListedPoint; head: boolean; live: boolean; s: Listed; open: Open; act(kind: NonNullable<Open>["kind"]): void; form: ReactNode }) {
  const app = useApp();
  const machine = machineOf(s.callsign ?? "") ?? s.owner;
  // живая — переносит её машина; только в архиве — поднимает любая машина с points.raise
  const canRaise = app.use(() => (live ? app.can(machine, "points.raise") === true : machinesWith(app, "points.raise").length > 0));
  const [pull, setPull] = useState(false);
  const on = (k: NonNullable<Open>["kind"]) => open?.kind === k;
  return (
    <div className="ss-card" data-card={p.id}>
      <div className="ss-facts">
        <span>{WHY[p.why] ?? p.why}</span>
        <span>{p.machine}</span>
        {p.msgs !== undefined ? <span>{countOf(p.msgs, "запись", "записи", "записей")}</span> : null}
        {p.git ? <span>{gitLine(p.git as never)}</span> : null}
        {head ? <Pill tone="ok">последняя</Pill> : !p.line ? <Pill tone="wait">ветка</Pill> : null}
      </div>
      <Opts className="ss-acts">
        {canRaise ? (
          live ? (
            <>
              <Btn data-act="move" aria-expanded={on("move")} onClick={() => act("move")}>
                Перенести на машину…
              </Btn>
              <Btn data-act="copy" aria-expanded={on("copy")} onClick={() => act("copy")}>
                Копия…
              </Btn>
              {!head ? (
                <Btn data-act="rb" aria-expanded={on("rb")} onClick={() => act("rb")}>
                  Откатить сюда…
                </Btn>
              ) : null}
            </>
          ) : (
            <Btn data-act="raise" aria-expanded={on("raise")} onClick={() => act("raise")}>
              Поднять на машине…
            </Btn>
          )
        ) : null}
        <Btn data-act="pull" aria-expanded={pull} onClick={() => setPull(!pull)}>
          На свой компьютер
        </Btn>
      </Opts>
      {form}
      {pull ? <Pull callsign={s.callsign} sid={s.sid} point={p.id} head={head} /> : null}
      <Calls sid={s.sid} point={p.id} />
    </div>
  );
}

function Points({ line, cur, pick, body }: { line: Line; cur: number; pick(id: number): void; body: ReactNode }) {
  const pts = [...line.points].sort((a, b) => b.at - a.at);
  const days = [...new Set(pts.map((p) => day(p.at)))];
  return (
    <div className="ss-line" data-points="">
      {days.map((d) => (
        <Fragment key={d}>
          <div className="pt-day">{d}</div>
          {pts
            .filter((p) => day(p.at) === d)
            .map((p) => {
              return (
                <div key={p.id} className={cur === p.id ? "pt-item on" : "pt-item"}>
                  <RowBtn className={p.line ? "pt-pt" : "pt-pt br"} data-point={p.id} aria-pressed={cur === p.id} onClick={() => pick(p.id)}>
                    <span>{hhmm(p.at)}</span>
                    <i />
                    <span>{WHY[p.why] ?? p.why}</span>
                    <em>{`№${p.id}`}</em>
                  </RowBtn>
                  {cur === p.id ? body : null}
                </div>
              );
            })}
        </Fragment>
      ))}
    </div>
  );
}

/** Шапка сессии: имя разговора, кто (ссылкой в карточку живой), где, чем и сколько. */
function Head({ s, live, inCard, children }: { s: Listed; live: boolean; inCard: boolean; children?: ReactNode }) {
  const app = useApp();
  return (
    <div className="ss-head">
      {inCard ? null : (
        <TextBtn className="ss-back" onClick={() => app.open("points", {})}>
          ← Сессии
        </TextBtn>
      )}
      <div className="ss-hrow">
        <h2 className="ss-h">{titleOf(s)}</h2>
        <Opts className="ss-hacts">{children}</Opts>
      </div>
      <div className="ss-meta">
        {inCard ? null : live && s.callsign ? (
          <TextBtn className="ss-cs" data-f="card" onClick={() => app.open("card", { callsign: s.callsign! })}>
            <M>{s.callsign}</M>
          </TextBtn>
        ) : (
          <M>{s.callsign ?? s.sid}</M>
        )}
        {s.project ? <span>{s.project}</span> : null}
        {inCard ? null : <span>{modelName(s.model)}</span>}
        <span className="ss-num">{tokens(s)}</span>
        {inCard ? null : live ? <Pill tone="ok">идёт</Pill> : <Pill>в архиве</Pill>}
      </div>
    </div>
  );
}

function DoneNote({ done }: { done: Done }) {
  const app = useApp();
  if (!done) return null;
  return (
    <Note tone="ok" role="status" data-done="">
      {done.text}
      {done.link ? (
        <>
          {" "}
          <TextBtn data-f="result" onClick={() => app.open("card", { callsign: done.link! })}>
            <M>{done.link}</M>
          </TextBtn>
        </>
      ) : null}
    </Note>
  );
}

export function SessionPage({ sid, point: start, uuid, q, pane: pane0, inCard = false, foot }: { sid: string; point?: number; uuid?: string; q?: string; pane?: string; inCard?: boolean; foot?: ReactNode }) {
  const app = useApp();
  const fleet = useModule<Fleet>();
  const s = app.use(() => fleet.bySid(sid));
  const fleetError = app.use(() => fleet.get().error);
  const callsign = s?.callsign;
  const live = app.use(() => !!callsign && !!s?.live && !!sessionOf(app, callsign));
  const machine = callsign ? machineOf(callsign)! : "";
  const canSave = app.use(() => live && app.can(machine, "points.save") === true);
  const line = useLoad<Line>(() => app.read<Line>("points.list", { sid }), [sid]);
  // выбранная точка: на экране — в адресе, во вкладке карточки — своя
  const [own, setOwn] = useState<number | null>(start ?? null);
  const picked = inCard ? own : (start ?? null);
  const [pane, setPane] = useState<Pane>(pane0 === "points" ? "points" : "talk");
  // вкладка телефона — в адресе вместе с точкой: экран пересоздаётся при смене адреса
  const pick = (id: number | null) => (setOpen(null), inCard ? setOwn(id) : app.open("points", { sid, ...(id === null ? {} : { point: String(id) }), ...(pane === "points" ? { pane } : {}) }));
  const [open, setOpen] = useState<Open>(null);
  const [note, setNote] = useState<OutcomeNote | null>(null);
  const done: Done = app.use(() => { const d = fleet.get().done; return d?.sid === sid ? d : undefined; });
  useEffect(() => void (s || fleet.read()), [s, fleet]);
  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(null);
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [open]);
  const head = line.data?.points.find((p) => p.id === line.data?.head) ?? line.data?.points.at(-1);
  const cur = line.data?.points.find((p) => p.id === picked) ?? head;
  const isHead = !!cur && cur.id === head?.id;
  const changed = () => {
    line.reload();
    void fleet.read();
  };
  const act = (kind: NonNullable<Open>["kind"]) => (fleet.said(), setOpen(open?.kind === kind ? null : { kind, n: (open?.n ?? 0) + 1 }));
  /** Действие дошло: окно закрыто, выбрана новая последняя точка, итог — строкой со ссылкой. */
  const finished = (text: string, link?: string) => {
    setOpen(null);
    fleet.said({ sid, text, link });
    changed();
    pick(null);
  };
  const save = async () => {
    setNote({ text: "Сохраняю точку…" });
    const r = await app.request<{ point: number; same: boolean }>("points.save", { callsign });
    setNote(r.ok ? { text: r.result.same ? `Точка №${r.result.point} — та же` : `Точка №${r.result.point}`, tone: "ok" } : { text: refused(r.error, { who: callsign }), tone: "bad" });
    changed();
  };
  const remove = async () => {
    const r = await app.request<{ points: number }>("points.delete", { sid });
    setOpen(null);
    if (!r.ok) return setNote({ text: refused(r.error), tone: "bad" });
    void fleet.read();
    app.open("points", {});
  };

  if (!s) {
    return (
      <Page className="ss-page">
        {fleetError ? <Note tone="bad" role="alert">{`Архив не загрузился: ${refused(fleetError)}`}</Note> : <Note>…</Note>}
      </Page>
    );
  }
  // окно действия точки — внутри выбранной точки в линии
  const form =
    open?.kind === "raise" && cur ? (
      <RaiseWindow key={open.n} s={s} point={cur.id} fleet={fleet} close={() => setOpen(null)} raised={(c) => finished("Поднята:", c)} />
    ) : open && (open.kind === "move" || open.kind === "copy" || open.kind === "rb") && callsign && head && cur ? (
      <Dialog key={open.n} kind={open.kind} callsign={callsign} sid={sid} head={head} from={isHead ? null : cur} close={() => setOpen(null)} changed={changed} done={finished} />
    ) : null;
  // разговор: точка линии — разговор головы с точками на своих местах и приглушённым хвостом; точка ветки — разговор на ней
  const onLine = !!cur && cur.line !== false;
  const marks = onLine
    ? (line.data?.points ?? [])
        .filter((p) => p.line !== false)
        .sort((a, b) => a.at - b.at)
        .map((p) => `${p.id}:${p.msgs ?? 0}:${hhmm(p.at)}`)
        .join(",")
    : "";
  const talk = cur && head ? { sid, point: String(onLine ? head.id : cur.id), marks, sel: isHead ? "" : String(cur.id), pick: "1", ...(callsign ? { callsign } : {}), ...(uuid ? { uuid } : {}), ...(q ? { q } : {}) } : null;
  const side = (
    <aside className="ss-side">
      {line.error ? <Note tone="bad">{`Точки не загрузились: ${refused(line.error)}`}</Note> : null}
      {cur && line.data ? (
        <>
          <H4>{line.data.points.some((p) => !p.line) ? "Точки и ветки" : "Точки"}</H4>
          <Points line={line.data} cur={cur.id} pick={pick} body={<PointBody p={cur} head={isHead} live={live} s={s} open={open} act={act} form={form} />} />
        </>
      ) : line.loading ? (
        <Note>…</Note>
      ) : null}
      {foot}
    </aside>
  );
  return (
    <Page className="ss-page" data-session={sid}>
      <Head s={s} live={live} inCard={inCard}>
        {canSave ? <Btn onClick={() => void save()}>Сохранить точку</Btn> : null}
        {live && head ? (
          <Btn data-act="dir" aria-expanded={open?.kind === "dir"} onClick={() => act("dir")}>
            Сменить папку…
          </Btn>
        ) : null}
        {!live ? (
          <Btn bad data-act="delete" aria-expanded={open?.kind === "delete"} onClick={() => act("delete")}>
            Удалить из архива…
          </Btn>
        ) : null}
      </Head>
      <Outcome data-note="" note={note} />
      <DoneNote done={done} />
      {open?.kind === "delete" ? <DeleteWindow key={open.n} s={s} go={() => void remove()} close={() => setOpen(null)} /> : null}
      {open?.kind === "dir" && callsign && head ? <Dialog key={open.n} kind="dir" callsign={callsign} sid={sid} head={head} from={null} close={() => setOpen(null)} changed={changed} done={finished} /> : null}
      {inCard ? (
        <div className="ss-body solo">{side}</div>
      ) : (
        <>
          <Tabs className="ss-panes" tabs={PANES} cur={pane} pick={(k) => setPane(k as Pane)} />
          <div className="ss-body" data-pane={pane}>
            {/* точка в ленте — кнопка data-mark: выбор ловим здесь, лента экранов пульта не знает */}
            <div
              className="ss-talk"
              onClick={(e) => {
                const m = (e.target as HTMLElement).closest<HTMLElement>("[data-mark]");
                if (m?.dataset.mark) pick(Number(m.dataset.mark));
              }}
            >
              {talk ? <app.Slot screen="chat.view" params={talk} /> : null}
            </div>
            {side}
          </div>
        </>
      )}
    </Page>
  );
}

/** Снять сессию с архива: подтверждение именем. */
function Unmark({ callsign, go, close }: { callsign: string; go(): void; close(): void }) {
  const name = nameOf(callsign);
  const [typed, setTyped] = useState("");
  return (
    <Sec dlg data-dlg="unmark">
      <b>{`Убрать ${callsign} из архива`}</b>
      <Note>{`Точки сессии удалятся сразу, без отмены. Сессия продолжит работу — без точек и переноса.`}</Note>
      <Opts>
        <span>{`Введите имя сессии: ${name}`}</span>
        <In mono data-f="unmark" placeholder={name} value={typed} onInput={(e) => setTyped(e.currentTarget.value)} />
      </Opts>
      <Opts>
        <Btn onClick={close}>Отмена</Btn>
        <Btn bad data-act="unmark" disabled={typed !== name} onClick={go}>
          Убрать из архива
        </Btn>
      </Opts>
    </Sec>
  );
}

/** Вкладка «Архив» карточки: линия точек с вызовами и «Хранить в архиве»; разговор — во вкладке карточки «Разговор». */
export function CardTab({ params }: { params: Record<string, string> }) {
  const app = useApp();
  const fleet = useModule<Fleet>();
  const callsign = params.callsign;
  const marked = app.use(() => sessionOf(app, callsign)?.archive !== undefined);
  // поле roster archive: { error, at } — последняя точка не удалась
  const failed = app.use(() => (sessionOf(app, callsign)?.archive as { error?: string } | undefined)?.error);
  const sid = app.use(() => fleet.sidOf(callsign)?.sid);
  const [note, setNote] = useState<OutcomeNote | null>(null);
  const [unmark, setUnmark] = useState(0);
  const [on, setOn] = useState(false);
  useEffect(() => void (marked && !sid && fleet.read()), [marked, sid, fleet]);
  const turn = async (want: boolean) => {
    setOn(want);
    setNote({ text: want ? "Включаю…" : "Удаляю точки…" });
    const r = await app.request<{ point?: number | null; deleted?: number }>("session.archive", { callsign, on: want });
    if (!r.ok) return setNote({ text: refused(r.error), tone: "bad" });
    setUnmark(0);
    setNote(want ? { text: r.result.point == null ? "Первая точка — на конце хода." : `Первая точка — №${r.result.point}.`, tone: "ok" } : { text: `${countOf(r.result.deleted ?? 0, "точка", "точки", "точек")} удалено.`, tone: "ok" });
    void fleet.read();
  };
  const toggle = (
    <Sec className="ss-keep">
      <OptsLabel>
        <Check checked={marked || on} data-act="archive" onChange={() => (marked ? setUnmark((n) => n + 1) : void turn(true))} />
        Хранить в архиве
      </OptsLabel>
      {failed ? <Note tone="bad" data-failed="">{`последняя точка не удалась: ${refused(failed)}`}</Note> : null}
      <Outcome data-note="" note={note} />
      {unmark ? <Unmark key={unmark} callsign={callsign} go={() => void turn(false)} close={() => setUnmark(0)} /> : null}
    </Sec>
  );
  if (!marked || !sid) return <Page className="ss-page">{toggle}</Page>;
  return <SessionPage sid={sid} inCard foot={toggle} />;
}
