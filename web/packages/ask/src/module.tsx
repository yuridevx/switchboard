// web-ask — вопросы сессий: кадры question и answered, запросы answer и question.list, экран вопроса,
// метка asked для списка. Ждущие вопросы держит модуль questions на Host — здесь только память экрана.
import { useEffect, useRef, useState } from "react";
import type { App, AppModule, Frame, Params, Roster, ScreenProps } from "@switchboard/web-core";
import type {} from "@switchboard/web-labels";
import { machineOf } from "@switchboard/protocol";
import { BadCard, Cta, hhmm, OkCard, Pad, WaitCard } from "@switchboard/web-ui";
import css from "./ask.css";

/** Вопрос AskUserQuestion: 1–4 на кадр, по 2–4 варианта; «Свой ответ» есть всегда. */
export type Question = {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: Array<{ label: string; description?: string }>;
};

type Status = "waiting" | "sending" | "ok" | "late" | "cancelled" | "gone" | "error";

/** Вопрос сессии в памяти модуля. */
type Rec = {
  id: string;
  callsign: string;
  kind: string;
  questions: Question[];
  /** форма MCP: message, schema, url, server */
  frame: Frame;
  to: string[];
  at: number;
  status: Status;
  error?: string;
  /** кто ответил и что — из answered или свой ответ */
  by?: string;
  answers?: Record<string, string>;
};

/** Новый модуль со своей памятью (в выпуске — один; в тестах — на каждый прогон). */
export function createAsk(): AppModule {
let app: App;
const recs = new Map<string, Rec>();
/** позывные, у которых надо взять question.list: пришёл пуш без вопросов */
const need = new Set<string>();
/** у кого question.list уже взят после этого hello */
const listed = new Set<string>();
/** позывной → идёт загрузка списка */
const loading = new Set<string>();
/** позывной → слово отказа последнего question.list */
const refused = new Map<string, string>();
/** позывной → вопрос на экране: шапка спрашивает его у модуля */
const onScreen = new Map<string, string>();
/** номер изменения памяти модуля: экран перечитывает её, когда номер сменился */
let rev = 0;

function changed() {
  rev++;
  app.changed();
}

function upsert(callsign: string, f: Frame | Record<string, unknown>, to: string[] = []) {
  const id = String(f.question);
  const old = recs.get(id);
  if (old) return old;
  const r: Rec = {
    id,
    callsign,
    kind: typeof f.kind === "string" ? f.kind : "ask",
    questions: Array.isArray(f.questions) ? (f.questions as Question[]) : [],
    frame: f as Frame,
    to,
    at: Date.now(),
    status: "waiting",
  };
  recs.set(id, r);
  return r;
}

const waitingOf = (callsign: string) => [...recs.values()].filter((r) => r.callsign === callsign && r.status === "waiting");

/** Ждущие вопросы сессии — у модуля questions её Host. */
async function list(callsign: string, force = false) {
  if (!force && listed.has(callsign)) return;
  listed.add(callsign);
  loading.add(callsign);
  changed();
  const r = await app.request<Array<Record<string, unknown>>>("question.list", { callsign });
  loading.delete(callsign);
  if (r.ok) {
    refused.delete(callsign);
    need.delete(callsign);
    const ids = new Set(r.result.map((q) => String(q.question)));
    // ждущие, которых Host больше не знает, — на них уже ответили
    for (const w of waitingOf(callsign)) if (!ids.has(w.id)) recs.delete(w.id);
    for (const q of r.result) upsert(callsign, q);
  } else {
    // отказ — словом на экране вопроса, а не «нет ждущих вопросов»
    refused.set(callsign, r.error);
    listed.delete(callsign);
  }
  changed();
}

function onQuestion(f: Frame, ctx: { open: boolean }) {
  const callsign = String(f.from);
  if (Array.isArray(f.questions) || f.kind === "form") upsert(callsign, f, Array.isArray(f.to) ? (f.to as string[]) : []);
  else {
    // из уведомления: в пуше только notify — сам вопрос берём у Host
    need.add(callsign);
    if (app.link() === "open") void list(callsign, true);
  }
  if (ctx.open) app.open("ask", { callsign });
  changed();
}

function onAnswered(f: Frame) {
  const r = recs.get(String(f.question));
  if (!r) return;
  if (f.cancelled) r.status = "cancelled";
  else if (r.status !== "ok") {
    r.by = typeof f.by === "string" ? f.by : undefined;
    r.answers = f.answers as Record<string, string> | undefined;
    r.status = r.by === app.name && r.status === "sending" ? "ok" : "late";
  }
  changed();
}

/** Машина сессии на связи: её соединение открыто и её roster пришёл — вопросы спрашиваются у её Host. */
const present = (callsign: string) => !!app.roster()?.machines.some((m) => m.machine === machineOf(callsign));

/** Сессии, чьи вопросы нужно спросить: из уведомлений без тела и с ждущими вопросами. */
const wanted = () => new Set([...need, ...[...recs.values()].filter((r) => r.status === "waiting").map((r) => r.callsign)]);

function onRoster(ro: Roster) {
  // машина появилась в roster флота — спросить вопросы её сессий, которых ждём
  for (const c of wanted()) if (present(c)) void list(c);
  for (const s of ro.sessions) if (s.state === "waiting" && !waitingOf(s.callsign).length) void list(s.callsign);
}

function onLink(s: string) {
  if (s !== "open") return;
  listed.clear();
  for (const c of wanted()) if (present(c)) void list(c);
}

/** Метка для списка: текст первого ждущего вопроса сессии. */
function asked(callsign: string): string | undefined {
  const r = waitingOf(callsign)[0];
  if (!r) return undefined;
  return r.questions[0]?.question ?? (typeof r.frame.message === "string" ? r.frame.message : "форма");
}

// показанный вопрос держится, пока он ждёт ответа; закрыт — следующий ждущий, нет его — итог показанного
function currentOf(callsign: string, shown: string | null | undefined): Rec | undefined {
  const s = shown ? recs.get(shown) : undefined;
  return s && (s.status === "waiting" || s.status === "sending" || s.status === "error") ? s : (waitingOf(callsign)[0] ?? s);
}

// ───── экран вопроса ─────

function Ask({ params }: ScreenProps) {
  const callsign = params.callsign ?? "";
  app.use(() => rev);
  const shown = useRef<string | null>(null);
  // показанный вопрос прошлого экрана этой сессии шапке больше не нужен
  useState(() => onScreen.delete(callsign));
  // выбор человека: текст вопроса → выбранные варианты; свой ответ — текстом
  const [picks, setPicks] = useState<Record<string, string[]>>({});
  const [own, setOwn] = useState<Record<string, string>>({});
  const [ownOn, setOwnOn] = useState<string[]>([]);
  const formVals = useRef<Record<string, unknown>>({});

  useEffect(() => void list(callsign, true), [callsign]);

  const r = currentOf(callsign, shown.current);
  if (r) {
    shown.current = r.id;
    onScreen.set(callsign, r.id);
  }

  function answersOf(rec: Rec): Record<string, string> | null {
    const out: Record<string, string> = {};
    for (const q of rec.questions) {
      const vals = [...(picks[q.question] ?? [])];
      if (ownOn.includes(q.question)) {
        const t = (own[q.question] ?? "").trim();
        if (!t) return null;
        vals.push(t);
      }
      if (!vals.length) return null;
      out[q.question] = vals.join(", ");
    }
    return out;
  }

  async function send(rec: Rec, body: Record<string, unknown>, mine?: Record<string, string>) {
    rec.status = "sending";
    rec.error = undefined;
    changed();
    const res = await app.request("answer", { callsign: rec.callsign, question: rec.id, ...body });
    if (res.ok) {
      rec.status = "ok";
      rec.by = app.name;
      rec.answers = mine;
    } else if (res.error === "already_answered") {
      // первый ответ выигрывает: свой повторно не шлём
      if (rec.status === "sending") rec.status = "late";
    } else if (res.error === "unknown_question") rec.status = "gone";
    else {
      rec.status = "error";
      rec.error = res.error;
    }
    changed();
  }

  function pick(q: Question, label: string) {
    const set = picks[q.question] ?? [];
    if (q.multiSelect) setPicks({ ...picks, [q.question]: set.includes(label) ? set.filter((x) => x !== label) : [...set, label] });
    else {
      setPicks({ ...picks, [q.question]: [label] });
      setOwnOn(ownOn.filter((x) => x !== q.question));
    }
  }

  function toggleOwn(q: Question) {
    if (ownOn.includes(q.question)) return setOwnOn(ownOn.filter((x) => x !== q.question));
    setOwnOn([...ownOn, q.question]);
    if (!q.multiSelect) {
      const { [q.question]: _, ...rest } = picks;
      setPicks(rest);
    }
  }

  function askBody(rec: Rec, locked: boolean) {
    const n = rec.questions.length;
    return rec.questions.map((q, i) => (
      <div key={q.question} className="ask-q">
        <div className="ask-qh">
          {q.header ? <span className="ask-chip">{q.header}</span> : <span />}
          <span className="ask-qn">{`вопрос ${i + 1} из ${n}`}</span>
        </div>
        <div className="ask-qt">{q.question}</div>
        <div className="ask-opts">
          {q.options.map((o) => (
            <button key={o.label} className={"ask-opt" + (q.multiSelect ? " multi" : "")} aria-pressed={picks[q.question]?.includes(o.label) ? "true" : "false"} disabled={locked} onClick={() => pick(q, o.label)}>
              <span>
                <b>{o.label}</b>
                {o.description ? <span>{o.description}</span> : null}
              </span>
            </button>
          ))}
          <button className="ask-opt own" aria-pressed={ownOn.includes(q.question) ? "true" : "false"} disabled={locked} onClick={() => toggleOwn(q)}>
            <span>
              <b>Свой ответ</b>
              <span>Написать сессии текстом</span>
            </span>
          </button>
          {ownOn.includes(q.question) ? (
            <input className="ask-own" type="text" data-own={q.question} placeholder="Ваш ответ" disabled={locked} autoFocus defaultValue={own[q.question] ?? ""} onInput={(e) => setOwn({ ...own, [q.question]: e.currentTarget.value })} />
          ) : null}
        </div>
      </div>
    ));
  }

  function formBody(rec: Rec, locked: boolean) {
    const f = rec.frame;
    const title = <div className="ask-qt">{String(f.message ?? "Форма")}</div>;
    if (typeof f.url === "string") {
      return (
        <div className="ask-q">
          {title}
          <a className="ask-url" href={f.url} target="_blank" rel="noopener">
            {f.url}
          </a>
        </div>
      );
    }
    const props = (f.schema as { properties?: Record<string, { type?: string; enum?: string[]; title?: string; description?: string }> })?.properties ?? {};
    const vals = formVals.current;
    return (
      <div className="ask-q">
        {title}
        {Object.entries(props).map(([k, p]) => {
          const num = p.type === "number" || p.type === "integer";
          return (
            <label key={k} className="ask-field">
              <span>{p.title ?? k}</span>
              {p.enum ? (
                <select className="ask-own" disabled={locked} defaultValue={typeof vals[k] === "string" ? vals[k] : ""} onChange={(e) => (vals[k] = e.currentTarget.value || undefined)}>
                  <option value="">—</option>
                  {p.enum.map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
              ) : p.type === "boolean" ? (
                <input type="checkbox" disabled={locked} defaultChecked={vals[k] === true} onChange={(e) => (vals[k] = e.currentTarget.checked)} />
              ) : (
                <input className="ask-own" type={num ? "number" : "text"} disabled={locked} defaultValue={vals[k] === undefined ? "" : String(vals[k])} onInput={(e) => (vals[k] = num ? Number(e.currentTarget.value) : e.currentTarget.value)} />
              )}
              {p.description ? <small>{p.description}</small> : null}
            </label>
          );
        })}
      </div>
    );
  }

  function result(rec: Rec) {
    const first = rec.answers ? Object.values(rec.answers).join("; ") : "";
    switch (rec.status) {
      case "ok":
        return (
          <OkCard role="status">
            <b>{first ? `Ответ «${first}» принят.` : "Ответ принят."}</b>
            <span>{`${rec.callsign} продолжила работу.`}</span>
          </OkCard>
        );
      case "late":
        return (
          <WaitCard role="status">
            <b>{rec.by ? `Уже ответили с ${rec.by}${first ? `: «${first}»` : ""}.` : "Уже ответили."}</b>
            <span>Первый ответ выигрывает — ваш не отправлен повторно.</span>
          </WaitCard>
        );
      case "cancelled":
        return (
          <WaitCard role="status">
            <b>Вопрос снят.</b>
            <span>Ход прервали — ответ больше не нужен.</span>
          </WaitCard>
        );
      case "gone":
        return (
          <WaitCard role="status">
            <b>Вопроса больше нет.</b>
            <span>{`${rec.callsign} его не ждёт: unknown_question.`}</span>
          </WaitCard>
        );
      case "error":
        return (
          <BadCard role="alert">
            <b>{`Не отправлено: ${rec.error}`}</b>
            <span>Ответ не дошёл — можно отправить ещё раз.</span>
          </BadCard>
        );
      default:
        return null;
    }
  }

  if (!r) {
    return (
      <Pad>
        <div className="ask-empty">{loading.has(callsign) ? "Загружаю вопросы…" : refused.has(callsign) ? `question.list: ${refused.get(callsign)}` : `У ${callsign} нет ждущих вопросов.`}</div>
      </Pad>
    );
  }
  const locked = r.status !== "waiting" && r.status !== "error";
  const others = r.to.filter((x) => x !== app.name);
  const url = typeof r.frame.url === "string";
  return (
    <Pad className="ask">
      {r.kind === "form" ? formBody(r, locked) : askBody(r, locked)}
      {!locked || r.status === "sending" ? (
        r.kind === "form" ? (
          <>
            <Cta disabled={r.status === "sending"} onClick={() => void send(r, url ? { action: "accept" } : { action: "accept", content: { ...formVals.current } })}>
              {url ? "Перешёл" : "Отправить"}
            </Cta>
            <button className="ask-decline" disabled={r.status === "sending"} onClick={() => void send(r, { action: "decline" })}>
              Отклонить
            </button>
          </>
        ) : (
          <Cta
            disabled={!answersOf(r) || r.status === "sending"}
            onClick={() => {
              const a = answersOf(r);
              if (a) void send(r, { answers: a }, a);
            }}
          >
            {r.status === "sending" ? "Отправляю…" : "Ответить"}
          </Cta>
        )
      ) : null}
      {result(r)}
      {r.to.length ? <div className="ask-hint">{`Вопрос видят: вы${others.length ? " и " + others.join(", ") : ""}`}</div> : null}
    </Pad>
  );
}

function head(params: Params) {
  const callsign = params.callsign ?? "";
  const r = currentOf(callsign, onScreen.get(callsign));
  const pill =
    !r || r.status === "waiting" || r.status === "sending" || r.status === "error"
      ? { text: "ждёт ответа", tone: "wait" as const }
      : r.status === "ok"
        ? { text: "ответ принят", tone: "ok" as const }
        : { text: r.status === "cancelled" ? "снят" : "уже ответили", tone: "" as const };
  const name = app.mark("label.session", callsign) ?? { text: callsign, human: false };
  return { title: name.text, mono: !name.human, sub: r ? `вопрос сессии · ${hhmm(r.at)}` : "вопрос сессии", pill: r || loading.has(callsign) ? pill : undefined };
}

return {
  frames: { question: onQuestion, answered: onAnswered },
  on: { roster: onRoster, link: onLink },
  screens: { ask: { label: "Вопрос", view: Ask, head } },
  marks: { asked },
  css,
  start(a) {
    app = a;
  },
};
}
