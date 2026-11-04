// Экран вопросов сессии: на весь экран и в месте над вводом чата. Первый незакрытый, иначе итог последнего.
import { useEffect, useState } from "react";
import { Area, BadCard, Btn, Check, Cta, In, Markdown, OkCard, Pad, RowBtn, Sel, useApp, useModule, WaitCard } from "@switchboard/web-ui";
import type { ScreenProps } from "@switchboard/web-core";
import type { AskItem, AskStore, Field, Question } from "./store.ts";
import { PLAN_TOOL, subjectOf, suggestionLines } from "./text.ts";

type Answer = (text: string, body: Record<string, unknown>) => void;

/** Приложения словами для «Вопрос видят». */
const APP_WORD: Record<string, string> = { pult: "пульт", phone: "телефон" };

export function AskScreen({ params }: ScreenProps) {
  const app = useApp();
  const store = useModule<AskStore>();
  const cs = params.callsign;
  useEffect(() => store.mounted(cs), [store, cs]);
  const qs = app.use(() => store.get().byCs[cs]);
  const loading = app.use(() => !!store.get().loading[cs]);
  const error = app.use(() => store.get().listError[cs]);
  const q = qs?.find((x) => !x.closed) ?? qs?.at(-1);
  if (!q) {
    return (
      <Pad>
        <div className="ask-empty">{loading ? "Загружаю вопросы…" : error ? `question.list: ${error}` : `У ${cs} нет ждущих вопросов.`}</div>
      </Pad>
    );
  }
  const answer: Answer = (text, body) => void store.answer(cs, q.question, text, body);
  const others = (q.to ?? []).filter((x) => x !== app.name).map((x) => APP_WORD[x] ?? x);
  return (
    <Pad className="ask">
      {/* новый вопрос — новый выбор: состояние выбора живёт вместе с вопросом */}
      <Card key={q.question} q={q} answer={answer} />
      <Outcome q={q} />
      {q.to?.length ? <div className="ask-hint">{`Вопрос видят: вы${others.length ? ` и ${others.join(", ")}` : ""}`}</div> : null}
    </Pad>
  );
}

function Card({ q, answer }: { q: Question; answer: Answer }) {
  if (q.kind === "perm") return <Perm q={q} answer={answer} />;
  if (q.kind === "ask") return <Asks q={q} answer={answer} />;
  return <Form q={q} answer={answer} />;
}

function Outcome({ q }: { q: Question }) {
  if (q.refused)
    return (
      <BadCard role="alert">
        <b>{`Не отправлено: ${q.refused}`}</b>
        <span>Ответ не дошёл — можно отправить ещё раз.</span>
      </BadCard>
    );
  const closed = q.closed;
  if (!closed) return null;
  if (closed.how === "mine")
    return (
      <OkCard role="status">
        <b>{closed.text ? `Ответ «${closed.text}» принят.` : "Ответ принят."}</b>
        <span>{`${q.callsign} продолжила работу.`}</span>
      </OkCard>
    );
  if (closed.how === "other")
    return (
      <WaitCard role="status">
        <b>{closed.by ? `Уже ответили с ${closed.by}${closed.text ? `: «${closed.text}»` : ""}.` : "Уже ответили."}</b>
        <span>Первый ответ выигрывает — ваш не отправлен повторно.</span>
      </WaitCard>
    );
  if (closed.how === "cancelled")
    return (
      <WaitCard role="status">
        <b>Вопрос снят.</b>
        <span>Ход прервали — ответ больше не нужен.</span>
      </WaitCard>
    );
  return (
    <WaitCard role="status">
      <b>Вопроса больше нет.</b>
      <span>{`${q.callsign} его не ждёт: unknown_question.`}</span>
    </WaitCard>
  );
}

// ───────────── AskUserQuestion ─────────────

/** Варианты плитками, «Свой ответ» текстом, кнопка ответа. Выбор — местное состояние вопроса. */
function Asks({ q, answer }: { q: Question; answer: Answer }) {
  const items = q.questions ?? [];
  const [picks, setPicks] = useState<Record<string, string[]>>({});
  const [own, setOwn] = useState<Record<string, string>>({});
  const [ownOn, setOwnOn] = useState<string[]>([]);
  const sending = q.sending !== undefined;
  const locked = !!q.closed || sending;

  function answers(): Record<string, string> | null {
    const out: Record<string, string> = {};
    for (const item of items) {
      const vals = [...(picks[item.question] ?? [])];
      if (ownOn.includes(item.question)) {
        const t = (own[item.question] ?? "").trim();
        if (!t) return null;
        vals.push(t);
      }
      if (!vals.length) return null;
      out[item.question] = vals.join(", ");
    }
    return out;
  }

  function pick(item: AskItem, label: string) {
    const set = picks[item.question] ?? [];
    if (item.multiSelect) setPicks({ ...picks, [item.question]: set.includes(label) ? set.filter((x) => x !== label) : [...set, label] });
    else {
      setPicks({ ...picks, [item.question]: [label] });
      setOwnOn(ownOn.filter((x) => x !== item.question));
    }
  }

  function toggleOwn(item: AskItem) {
    if (ownOn.includes(item.question)) return setOwnOn(ownOn.filter((x) => x !== item.question));
    setOwnOn([...ownOn, item.question]);
    if (!item.multiSelect) {
      const { [item.question]: _, ...rest } = picks;
      setPicks(rest);
    }
  }

  const ready = answers();
  return (
    <>
      {items.map((item, n) => (
        <div className="ask-q" key={item.question}>
          {item.header || items.length > 1 ? (
            <div className="ask-qh">
              {item.header ? <span className="ask-chip">{item.header}</span> : <span />}
              {items.length > 1 ? <span className="ask-qn">{`вопрос ${n + 1} из ${items.length}`}</span> : null}
            </div>
          ) : null}
          <div className="ask-qt">{item.question}</div>
          <div className="ask-opts">
            {(item.options ?? []).map((o) => (
              <RowBtn key={o.label} className={item.multiSelect ? "ask-opt multi" : "ask-opt"} aria-pressed={picks[item.question]?.includes(o.label) ? "true" : "false"} disabled={locked} onClick={() => pick(item, o.label)}>
                <span>
                  <b>{o.label}</b>
                  {o.description ? <span>{o.description}</span> : null}
                </span>
              </RowBtn>
            ))}
            <RowBtn className="ask-opt own" aria-pressed={ownOn.includes(item.question) ? "true" : "false"} disabled={locked} onClick={() => toggleOwn(item)}>
              <span>
                <b>Свой ответ</b>
              </span>
            </RowBtn>
            {ownOn.includes(item.question) ? <In className="ask-own" type="text" data-own={item.question} placeholder="Ваш ответ" disabled={locked} autoFocus value={own[item.question] ?? ""} onInput={(e) => setOwn({ ...own, [item.question]: e.currentTarget.value })} /> : null}
          </div>
        </div>
      ))}
      {!q.closed ? (
        <Cta
          disabled={!ready || sending}
          onClick={() => {
            if (ready) answer(Object.values(ready).join("; "), { answers: ready });
          }}
        >
          {sending ? "Отправляю…" : "Ответить"}
        </Cta>
      ) : null}
    </>
  );
}

// ───────────── Запрос разрешения и план ─────────────

/** Вход целиком — если суть говорит не всё. */
function FullInput({ input, subject }: { input: Record<string, unknown>; subject: string }) {
  const rest = Object.entries(input).filter(([, v]) => v !== subject);
  if (!rest.length) return null;
  return (
    <details className="ask-more">
      <summary>Весь вход</summary>
      <pre>{JSON.stringify(input, null, 2)}</pre>
    </details>
  );
}

/** Запрос разрешения и одобрение плана: «всегда» — только если предложил SDK; ответ за человека не выбирается никогда. */
function Perm({ q, answer }: { q: Question; answer: Answer }) {
  const plan = q.tool === PLAN_TOOL;
  const input = (q.input ?? {}) as Record<string, unknown>;
  const [denying, setDenying] = useState(false);
  const [why, setWhy] = useState("");
  const sending = q.sending !== undefined;
  const subject = plan ? "" : subjectOf(input);
  const deny = () => {
    const message = why.trim();
    answer(plan ? "Вернуть" : "Отклонить", { action: "deny", ...(message ? { message } : {}) });
  };
  return (
    <>
      <div className="ask-q">
        <div className="ask-qt">{plan ? "План на одобрение" : "Claude просит разрешения"}</div>
        {plan ? (
          <div className="ask-plan">
            <Markdown text={String(input.plan ?? "").replace(/^\s*#{1,6}\s*план\s*\n+/i, "")} />
          </div>
        ) : (
          <>
            <div className="ask-qh">
              <span className="ask-chip">{q.displayName ?? q.tool}</span>
            </div>
            {subject ? <code className="ask-subject">{subject}</code> : null}
            {q.title ? <div className="ask-note">{q.title}</div> : null}
            {q.description && q.description !== q.title ? <div className="ask-note">{q.description}</div> : null}
            {q.reason ? <div className="ask-note">{q.reason}</div> : null}
            {q.blockedPath ? <code className="ask-path">{q.blockedPath}</code> : null}
            <FullInput input={input} subject={subject} />
          </>
        )}
      </div>
      {q.closed ? null : denying ? (
        <>
          <Area className="ask-own" rows={2} aria-label={plan ? "Замечания" : "Причина"} placeholder={plan ? "Замечания" : "Причина"} autoFocus disabled={sending} value={why} onInput={(e) => setWhy(e.currentTarget.value)} />
          <div className="ask-acts">
            <Cta disabled={sending} onClick={deny}>
              {plan ? "Вернуть" : "Отклонить"}
            </Cta>
            <Btn type="button" className="ask-decline" disabled={sending} onClick={() => setDenying(false)}>
              Назад
            </Btn>
          </div>
        </>
      ) : (
        <>
          {plan
            ? null
            : suggestionLines(q.suggestions).map((l) => (
                <div className="ask-note" key={l}>
                  {l}
                </div>
              ))}
          <div className="ask-acts">
            <Cta disabled={sending} onClick={() => answer(plan ? "Одобрить" : "Разрешить", { action: "allow" })}>
              {plan ? "Одобрить" : "Разрешить"}
            </Cta>
            {plan || q.suggestions?.length ? (
              <Btn type="button" className="ask-decline" disabled={sending} onClick={() => answer(plan ? "Одобрить и разрешать правки" : "Разрешать всегда", { action: "allow", always: true })}>
                {plan ? "Одобрить и разрешать правки" : "Разрешать всегда"}
              </Btn>
            ) : null}
            <Btn type="button" className="ask-decline" disabled={sending} onClick={() => setDenying(true)}>
              {plan ? "Вернуть с замечаниями" : "Отклонить"}
            </Btn>
          </div>
        </>
      )}
    </>
  );
}

// ───────────── Формы MCP ─────────────

const isNumber = (f: Field) => f.type === "number" || f.type === "integer";

/** Форма MCP-сервера: поля по схеме или ссылка. В поле числа значение — текстом, как набрано; в ответ идёт числом. */
function Form({ q, answer }: { q: Question; answer: Answer }) {
  const [vals, setVals] = useState<Record<string, string | boolean | undefined>>({});
  const props = q.schema?.properties ?? {};
  const sending = q.sending !== undefined;
  const locked = !!q.closed || sending;
  const set = (k: string, v: string | boolean | undefined) => setVals((old) => ({ ...old, [k]: v }));
  const content = () => Object.fromEntries(Object.entries(vals).map(([k, v]) => [k, props[k] && isNumber(props[k]) ? Number(v) : v]));
  return (
    <>
      <div className="ask-q">
        <div className="ask-qt">{q.message ?? "Форма"}</div>
        {q.url ? (
          <a className="ask-url" href={q.url} target="_blank" rel="noopener">
            {q.url}
          </a>
        ) : (
          Object.entries(props).map(([k, f]) => (
            <label key={k} className="ask-field">
              <span>{f.title ?? k}</span>
              {f.enum ? (
                <Sel className="ask-own" disabled={locked} value={typeof vals[k] === "string" ? vals[k] : ""} onChange={(e) => set(k, e.currentTarget.value || undefined)}>
                  <option value="">—</option>
                  {f.enum.map((v) => (
                    <option key={String(v)} value={String(v)}>
                      {String(v)}
                    </option>
                  ))}
                </Sel>
              ) : f.type === "boolean" ? (
                <Check disabled={locked} checked={vals[k] === true} onChange={(e) => set(k, e.currentTarget.checked)} />
              ) : (
                <In className="ask-own" type={isNumber(f) ? "number" : "text"} disabled={locked} value={typeof vals[k] === "string" ? vals[k] : ""} onInput={(e) => set(k, e.currentTarget.value)} />
              )}
              {f.description ? <small>{f.description}</small> : null}
            </label>
          ))
        )}
      </div>
      {!q.closed ? (
        <>
          <Cta disabled={sending} onClick={() => answer("", q.url ? { action: "accept" } : { action: "accept", content: content() })}>
            {q.url ? "Перешёл" : "Отправить"}
          </Cta>
          <Btn className="ask-decline" disabled={sending} onClick={() => answer("", { action: "decline" })}>
            Отклонить
          </Btn>
        </>
      ) : null}
    </>
  );
}
