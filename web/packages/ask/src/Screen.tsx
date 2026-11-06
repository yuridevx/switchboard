// Экран вопроса: AskUserQuestion, запрос разрешения, план и форма MCP. На весь экран — в обёртке страницы; в чужом месте (над вводом, в «Вам») — только вопрос.
import { useEffect, useState, type ReactNode } from "react";
import { Area, BadCard, Btn, Cta, In, Markdown, OkCard, Pad, PERM_PLACES, permModeName, RowBtn, Sel, useApp, useModule, WaitCard, type Params } from "@switchboard/web-ui";
import { subjectOf, type AskStore, type Entry, type Question } from "./store.ts";

type Reply = (reply: Record<string, unknown>, text: string) => void;
type Props = { q: Question; sending: boolean; closed: boolean; reply: Reply };

const LATE = "Первый ответ выигрывает — ваш не отправлен повторно.";
const APP_NAMES: Record<string, string> = { pult: "пульт", phone: "телефон" };

/** Варианты вопроса: один или несколько, свой ответ. */
function AskQuestions({ q, sending, closed, reply }: Props) {
  const list = q.questions ?? [];
  const [picked, setPicked] = useState<Record<number, string[]>>({});
  const [own, setOwn] = useState<Record<number, string | null>>({});
  const answerOf = (i: number) => [...(picked[i] ?? []), ...(own[i]?.trim() ? [own[i]!.trim()] : [])].join(", ");
  const toggle = (i: number, label: string, many?: boolean) => {
    const was = picked[i] ?? [];
    setPicked({ ...picked, [i]: many ? (was.includes(label) ? was.filter((x) => x !== label) : [...was, label]) : was.includes(label) ? [] : [label] });
    if (!many) setOwn({ ...own, [i]: null });
  };
  const toggleOwn = (i: number, many?: boolean) => {
    setOwn({ ...own, [i]: own[i] === undefined || own[i] === null ? "" : null });
    if (!many) setPicked({ ...picked, [i]: [] });
  };
  const ready = list.every((_, i) => answerOf(i));
  return (
    <>
      {list.map((x, i) => (
        <div key={i} className="ask-q">
          {x.header || list.length > 1 ? (
            <div className="ask-qh">
              {x.header ? <span className="ask-chip">{x.header}</span> : <span />}
              {list.length > 1 ? <span className="ask-qn">{`вопрос ${i + 1} из ${list.length}`}</span> : null}
            </div>
          ) : null}
          <div className="ask-qt">{x.question}</div>
          <div className="ask-opts">
            {(x.options ?? []).map((o) => (
              <RowBtn key={o.label} className={x.multiSelect ? "ask-opt multi" : "ask-opt"} aria-pressed={(picked[i] ?? []).includes(o.label)} disabled={closed} onClick={() => toggle(i, o.label, x.multiSelect)}>
                <span>
                  <b>{o.label}</b>
                  {o.description ? <span>{o.description}</span> : null}
                </span>
              </RowBtn>
            ))}
            <RowBtn className="ask-opt own" aria-pressed={own[i] !== undefined && own[i] !== null} disabled={closed} onClick={() => toggleOwn(i, x.multiSelect)}>
              <span>
                <b>Свой ответ</b>
              </span>
            </RowBtn>
            {own[i] !== undefined && own[i] !== null ? <In className="ask-own" data-own={x.question} type="text" placeholder="Ваш ответ" value={own[i]!} disabled={closed} onInput={(e) => setOwn({ ...own, [i]: e.currentTarget.value })} /> : null}
          </div>
        </div>
      ))}
      {closed ? null : (
        <Cta disabled={!ready || sending} onClick={() => reply({ answers: Object.fromEntries(list.map((x, i) => [x.question, answerOf(i)])) }, list.map((_, i) => answerOf(i)).join(", "))}>
          {sending ? "Отправляю…" : "Ответить"}
        </Cta>
      )}
    </>
  );
}

/** Строка «что ляжет навсегда»: правило и место, одной строкой на предложение. */
function suggestionLine(s: Record<string, unknown>): string {
  const place = PERM_PLACES[String(s.destination)] ?? String(s.destination ?? "");
  const rules = (s.rules ?? []) as Array<{ toolName?: string; ruleContent?: string }>;
  const what = s.type === "setMode" ? (permModeName(String(s.mode)) ?? String(s.mode)) : s.type === "addDirectories" ? ((s.directories ?? []) as string[]).join(", ") : rules.map((r) => (r.ruleContent ? `${r.toolName}(${r.ruleContent})` : String(r.toolName))).join(", ");
  return [what, place].filter(Boolean).join(" · ");
}

/** Заголовок «План» в начале текста не повторяется: он уже в заголовке вопроса. */
const planText = (input?: Record<string, unknown>) => String(input?.plan ?? "").replace(/^\s*#+\s*План\s*\n+/, "");

function PermQuestion({ q, sending, closed, reply }: Props) {
  const [deny, setDeny] = useState<string | null>(null);
  const plan = q.tool === "ExitPlanMode";
  const input = q.input ?? {};
  const subject = subjectOf(q);
  const notes = [...new Set([q.title, q.description, q.reason])].filter(Boolean) as string[];
  const wordDeny = plan ? "Вернуть" : "Отклонить";
  const note = plan ? "Замечания" : "Причина";
  return (
    <>
      <div className="ask-q">
        <div className="ask-qt">{plan ? "План на одобрение" : "Claude просит разрешения"}</div>
        {plan ? (
          <div className="ask-plan">
            <Markdown text={planText(input)} />
          </div>
        ) : (
          <>
            <span className="ask-chip">{q.tool}</span>
            {subject ? <code className="ask-subject">{subject}</code> : null}
            {notes.map((n) => (
              <div key={n} className="ask-note">
                {n}
              </div>
            ))}
            {q.blockedPath ? <code className="ask-path">{q.blockedPath}</code> : null}
            <details className="ask-more">
              <summary>Весь вход</summary>
              <pre>{JSON.stringify(input, null, 2)}</pre>
            </details>
          </>
        )}
      </div>
      {!plan && q.suggestions?.length && !closed && deny === null
        ? q.suggestions.map((s, i) => (
            <div key={i} className="ask-note">
              {suggestionLine(s)}
            </div>
          ))
        : null}
      {closed ? null : deny !== null ? (
        <>
          <Area className="ask-own" rows={2} placeholder={note} aria-label={note} value={deny} onInput={(e) => setDeny(e.currentTarget.value)} />
          <div className="ask-acts">
            <Cta disabled={sending} onClick={() => reply({ action: "deny", ...(deny.trim() ? { message: deny.trim() } : {}) }, wordDeny)}>
              {wordDeny}
            </Cta>
            <Btn type="button" className="ask-decline" onClick={() => setDeny(null)}>
              Назад
            </Btn>
          </div>
        </>
      ) : (
        <div className="ask-acts">
          <Cta disabled={sending} onClick={() => reply({ action: "allow" }, plan ? "Одобрить" : "Разрешить")}>
            {plan ? "Одобрить" : "Разрешить"}
          </Cta>
          {plan ? (
            <Btn type="button" className="ask-decline" disabled={sending} onClick={() => reply({ action: "allow", always: true }, "Одобрить и разрешать правки")}>
              Одобрить и разрешать правки
            </Btn>
          ) : q.suggestions?.length ? (
            <Btn type="button" className="ask-decline" disabled={sending} onClick={() => reply({ action: "allow", always: true }, "Разрешать всегда")}>
              Разрешать всегда
            </Btn>
          ) : null}
          <Btn type="button" className="ask-decline" disabled={sending} onClick={() => setDeny("")}>
            {plan ? "Вернуть с замечаниями" : "Отклонить"}
          </Btn>
        </div>
      )}
    </>
  );
}

type Field = NonNullable<NonNullable<Question["schema"]>["properties"]>[string];
const isNumber = (f: Field) => f.type === "number" || f.type === "integer";

function FormQuestion({ q, sending, closed, reply }: Props) {
  const [values, setValues] = useState<Record<string, string>>({});
  const fields = Object.entries(q.schema?.properties ?? {});
  const content = () => Object.fromEntries(fields.flatMap(([k, f]) => (values[k] ? [[k, isNumber(f) ? Number(values[k]) : values[k]]] : [])));
  return (
    <>
      <div className="ask-q">
        <div className="ask-qt">{q.message || "Форма"}</div>
        {q.url ? (
          <a className="ask-url" href={q.url} target="_blank" rel="noopener">
            {q.url}
          </a>
        ) : null}
        {fields.map(([k, f]) => {
          const set = (value: string) => setValues((was) => ({ ...was, [k]: value }));
          return (
            <label key={k} className="ask-field">
              <span>{f.title ?? k}</span>
              {f.enum ? (
                <Sel className="ask-own" value={values[k] ?? ""} disabled={closed} onChange={(e) => set(e.currentTarget.value)}>
                  <option value="">—</option>
                  {f.enum.map((v) => (
                    <option key={String(v)} value={String(v)}>
                      {String(v)}
                    </option>
                  ))}
                </Sel>
              ) : (
                <In className="ask-own" type={isNumber(f) ? "number" : "text"} value={values[k] ?? ""} disabled={closed} onInput={(e) => set(e.currentTarget.value)} />
              )}
              {f.description ? <small>{f.description}</small> : null}
            </label>
          );
        })}
      </div>
      {closed ? null : (
        <>
          <Cta disabled={sending} onClick={() => reply(q.url ? { action: "accept" } : { action: "accept", content: content() }, "")}>
            {sending ? "Отправляю…" : q.url ? "Перешёл" : "Отправить"}
          </Cta>
          <Btn className="ask-decline" disabled={sending} onClick={() => reply({ action: "decline" }, "Отклонить")}>
            Отклонить
          </Btn>
        </>
      )}
    </>
  );
}

function Outcome({ e, callsign }: { e: Entry; callsign: string }) {
  const d = e.done;
  const two = (head: string, tail?: string, Card: typeof OkCard = WaitCard): ReactNode => (
    <Card role="status">
      <b>{head}</b>
      {tail ? <span>{tail}</span> : null}
    </Card>
  );
  if (e.word)
    return (
      <BadCard role="alert">
        <b>{`Не отправлено: ${e.word}`}</b>
        <span>Ответ не дошёл — можно отправить ещё раз.</span>
      </BadCard>
    );
  if (!d) return null;
  switch (d.how) {
    case "mine":
      return two(d.text ? `Ответ «${d.text}» принят.` : "Ответ принят.", `${callsign} продолжила работу.`, OkCard);
    case "already":
      return two("Уже ответили.", LATE);
    case "other":
      return two(`Уже ответили с ${d.by}${d.text ? `: «${d.text}»` : ""}.`, LATE);
    case "cancelled":
      return two("Вопрос снят.", "Ход прервали — ответ больше не нужен.");
    case "gone":
      return two("Вопроса больше нет.", `${callsign} его не ждёт: ${d.word}.`);
  }
}

function Audience({ q }: { q: Question }) {
  const app = useApp();
  if (!q.to) return null;
  const others = q.to.filter((n) => n !== app.name && n !== app.address());
  return <div className="ask-hint">{`Вопрос видят: вы${others.length ? ` и ${others.map((n) => APP_NAMES[n] ?? n).join(", ")}` : ""}`}</div>;
}

export function AskScreen({ params }: { params: Params }) {
  const app = useApp();
  const asks = useModule<AskStore>();
  const { callsign } = params;
  useEffect(() => asks.mount(callsign), [callsign]); // eslint-disable-line react-hooks/exhaustive-deps
  const e = app.use(() => asks.shown(callsign));
  const loading = app.use(() => asks.asks(callsign).loading);
  const word = app.use(() => asks.asks(callsign).word);
  const inPlace = app.current()?.screen !== "ask";
  if (!e && inPlace) return null;
  if (!e)
    return (
      <Pad>
        <div className="ask-empty">{word || (loading ? "Загружаю вопросы…" : `У ${callsign} нет ждущих вопросов.`)}</div>
      </Pad>
    );
  const props: Props = { q: e.q, sending: e.sending, closed: !!e.done, reply: (reply, text) => void asks.answer(callsign, e.q.question, reply, text) };
  return (
    <Pad className="ask">
      {e.q.kind === "ask" ? <AskQuestions key={e.q.question} {...props} /> : e.q.kind === "perm" ? <PermQuestion key={e.q.question} {...props} /> : <FormQuestion key={e.q.question} {...props} />}
      <Outcome e={e} callsign={callsign} />
      <Audience q={e.q} />
    </Pad>
  );
}
