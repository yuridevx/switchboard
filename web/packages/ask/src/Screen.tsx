// Экран вопроса сессии: AskUserQuestion, запрос разрешения и план, форма и ссылка MCP. Первый ответ выигрывает.
import { useState, type ReactNode } from "react";
import { Area, Btn, Cta, In, Markdown, Note, Pad, PERM_PLACES, permModeName, RowBtn, Sel, useApp, useModule, type Params } from "@switchboard/web-ui";
import type { Ask, Asked, Outcome } from "./store.ts";

type Opt = { label?: string; description?: string };
type Q = { question?: string; header?: string; multiSelect?: boolean; options?: Opt[] };
type Rule = { type?: string; rules?: Array<{ toolName?: string; ruleContent?: string }>; mode?: string; directories?: string[]; destination?: string };
type Body = Record<string, unknown>;

const LATE = "Первый ответ выигрывает — ваш не отправлен повторно.";
const APPS: Record<string, string> = { pult: "пульт", phone: "телефон" };

/** Суть входа инструмента: команда, файл, адрес или запрос. */
export const subjectOf = (input: Body = {}): string => String(input.command ?? input.file_path ?? input.notebook_path ?? input.url ?? input.query ?? input.pattern ?? input.path ?? "");

/** Что предложил SDK запомнить: строка на предложение. */
export function ruleLine(r: Rule): string {
  const what = r.type === "setMode" ? (permModeName(r.mode ?? "") ?? r.mode) : r.type === "addDirectories" ? r.directories?.join(", ") : r.rules?.map((x) => (x.ruleContent ? `${x.toolName}(${x.ruleContent})` : x.toolName)).join(", ");
  return `${what} · ${PERM_PLACES[r.destination ?? ""] ?? r.destination}`;
}

function Done({ d, cs }: { d: Outcome; cs: string }) {
  const [b, span]: [string, string] =
    d.word === "ours" ? [d.said ? `Ответ «${d.said}» принят.` : "Ответ принят.", `${cs} продолжила работу.`]
    : d.word === "theirs" ? [d.said ? `Уже ответили с ${d.by}: «${d.said}».` : `Уже ответили с ${d.by}.`, LATE]
    : d.word === "late" ? ["Уже ответили.", LATE]
    : d.word === "cancelled" ? ["Вопрос снят.", "Ход прервали — ответ больше не нужен."]
    : d.word === "gone" ? ["Вопроса больше нет.", `${cs} его не ждёт: ${d.error}.`]
    : [`Не отправлено: ${d.error}`, "Ответ не дошёл — можно отправить ещё раз."];
  return (
    <Note role={d.word === "failed" ? "alert" : "status"} tone={d.word === "ours" ? "ok" : d.word === "failed" ? "bad" : "wait"}>
      <b>{b}</b> <span>{span}</span>
    </Note>
  );
}

function Pick({ q, n, of, value, set, off }: { q: Q; n: number; of: number; value: string[]; set(v: string[]): void; off: boolean }) {
  const [own, setOwn] = useState<string | null>(null);
  const toggle = (label: string) => set(q.multiSelect ? (value.includes(label) ? value.filter((x) => x !== label) : [...value, label]) : [label]);
  const ownOn = own !== null;
  const put = (text: string | null) => {
    setOwn(text);
    const picked = q.multiSelect ? value.filter((v) => (q.options ?? []).some((o) => o.label === v)) : [];
    set(text === null ? picked : [...picked, ...(text ? [text] : [])]);
  };
  return (
    <div className="ask-q">
      <div className="ask-qh">
        {q.header && <span className="ask-chip">{q.header}</span>}
        {of > 1 && <span className="ask-qn">{`вопрос ${n} из ${of}`}</span>}
      </div>
      <div className="ask-qt">{q.question}</div>
      <div className="ask-opts">
        {(q.options ?? []).map((o) => (
          <RowBtn key={o.label} className={q.multiSelect ? "ask-opt multi" : "ask-opt"} aria-pressed={value.includes(o.label ?? "")} disabled={off} onClick={() => toggle(o.label ?? "")}>
            <span>
              <b>{o.label}</b>
              {o.description && <span>{o.description}</span>}
            </span>
          </RowBtn>
        ))}
        <RowBtn className="ask-opt own" aria-pressed={ownOn} disabled={off} onClick={() => put(ownOn && !q.multiSelect ? null : (own ?? ""))}>
          <span>
            <b>Свой ответ</b>
          </span>
        </RowBtn>
        {ownOn && <In className="ask-own" type="text" data-own={q.question} placeholder="Ваш ответ" value={own} disabled={off} onInput={(e) => put(e.currentTarget.value)} />}
      </div>
    </div>
  );
}

function AskQ({ cs, q, send, off }: { cs: string; q: Asked; send(b: Body): void; off: boolean }) {
  const qs = (q.questions ?? []) as Q[];
  const [values, setValues] = useState<string[][]>(() => qs.map(() => []));
  const ready = values.every((v) => v.some(Boolean));
  return (
    <>
      {qs.map((x, i) => (
        <Pick key={i} q={x} n={i + 1} of={qs.length} value={values[i]} off={off} set={(v) => setValues((all) => all.map((w, j) => (j === i ? v : w)))} />
      ))}
      {!off && (
        <Cta disabled={!ready || q.sending} onClick={() => send({ answers: Object.fromEntries(qs.map((x, i) => [x.question, values[i].filter(Boolean).join(", ")])) })}>
          {q.sending ? "Отправляю…" : "Ответить"}
        </Cta>
      )}
      <Hint cs={cs} q={q} />
    </>
  );
}

function PermQ({ q, send, off }: { q: Asked; send(b: Body): void; off: boolean }) {
  const [deny, setDeny] = useState(false);
  const [why, setWhy] = useState("");
  const plan = q.tool === "ExitPlanMode";
  const input = (q.input ?? {}) as Body;
  const rules = ((q.suggestions ?? []) as Rule[]).map(ruleLine);
  const words = plan ? ["Одобрить", "Одобрить и разрешать правки", "Вернуть с замечаниями", "Замечания", "Вернуть"] : ["Разрешить", "Разрешать всегда", "Отклонить", "Причина", "Отклонить"];
  const notes = [...new Set([q.title, q.description, q.reason].filter(Boolean) as string[])];
  return (
    <>
      <div className="ask-q">
        <div className="ask-qt">{plan ? "Claude предлагает план" : "Claude просит разрешения"}</div>
        {plan ? (
          <div className="ask-plan">
            <Markdown text={String(input.plan ?? "").replace(/^\s*#+\s*План\s*\n/, "")} />
          </div>
        ) : (
          <>
            <span className="ask-chip">{String(q.tool)}</span>
            {subjectOf(input) && <code className="ask-subject">{subjectOf(input)}</code>}
            {notes.map((n) => (
              <div key={n} className="ask-note">
                {n}
              </div>
            ))}
            {typeof q.blockedPath === "string" && <code className="ask-path">{q.blockedPath}</code>}
            <details className="ask-more">
              <summary>Весь вход</summary>
              <pre>{JSON.stringify(input, null, 2)}</pre>
            </details>
          </>
        )}
      </div>
      {!off &&
        (deny ? (
          <>
            <Area className="ask-own" rows={2} placeholder={words[3]} aria-label={words[3]} value={why} onInput={(e) => setWhy(e.currentTarget.value)} />
            <div className="ask-acts">
              <Cta disabled={q.sending} onClick={() => send({ action: "deny", ...(why.trim() ? { message: why.trim() } : {}), label: words[2] })}>
                {words[4]}
              </Cta>
              <Btn type="button" className="ask-decline" onClick={() => setDeny(false)}>
                Назад
              </Btn>
            </div>
          </>
        ) : (
          <>
            {rules.map((r) => (
              <div key={r} className="ask-note">
                {r}
              </div>
            ))}
            <div className="ask-acts">
              <Cta disabled={q.sending} onClick={() => send({ action: "allow", label: words[0] })}>
                {q.sending ? "Отправляю…" : words[0]}
              </Cta>
              {(plan || rules.length > 0) && (
                <Btn type="button" className="ask-decline" disabled={q.sending} onClick={() => send({ action: "allow", always: true, label: words[1] })}>
                  {words[1]}
                </Btn>
              )}
              <Btn type="button" className="ask-decline" onClick={() => setDeny(true)}>
                {words[2]}
              </Btn>
            </div>
          </>
        ))}
    </>
  );
}

type Field = { type?: string; enum?: unknown[]; title?: string; description?: string };

function FormQ({ q, send, off }: { q: Asked; send(b: Body): void; off: boolean }) {
  const props = ((q.schema as { properties?: Record<string, Field> } | undefined)?.properties ?? {}) as Record<string, Field>;
  const [vals, setVals] = useState<Record<string, string>>({});
  const url = typeof q.url === "string" ? q.url : null;
  const set = (k: string, v: string) => setVals((x) => ({ ...x, [k]: v }));
  const content = () => Object.fromEntries(Object.entries(vals).filter(([, v]) => v !== "").map(([k, v]) => [k, props[k]?.type === "integer" || props[k]?.type === "number" ? Number(v) : v]));
  return (
    <>
      <div className="ask-q">
        <div className="ask-qt">{String(q.message ?? "")}</div>
        {url ? (
          <a className="ask-url" href={url} target="_blank" rel="noopener">
            {url}
          </a>
        ) : (
          Object.entries(props).map(([k, f]) => (
            <label key={k} className="ask-field">
              <span>{f.title ?? k}</span>
              {f.enum ? (
                <Sel className="ask-own" value={vals[k] ?? ""} disabled={off} onChange={(e) => set(k, e.target.value)}>
                  <option value="">—</option>
                  {f.enum.map((v) => (
                    <option key={String(v)} value={String(v)}>
                      {String(v)}
                    </option>
                  ))}
                </Sel>
              ) : (
                <In className="ask-own" type={f.type === "integer" || f.type === "number" ? "number" : "text"} value={vals[k] ?? ""} disabled={off} onInput={(e) => set(k, e.currentTarget.value)} />
              )}
              {f.description && <small>{f.description}</small>}
            </label>
          ))
        )}
      </div>
      {!off && (
        <>
          <Cta disabled={q.sending} onClick={() => send(url ? { action: "accept" } : { action: "accept", content: content() })}>
            {q.sending ? "Отправляю…" : url ? "Перешёл" : "Отправить"}
          </Cta>
          <Btn type="button" className="ask-decline" onClick={() => send({ action: "decline" })}>
            Отклонить
          </Btn>
        </>
      )}
    </>
  );
}

function Hint({ cs: _cs, q }: { cs: string; q: Asked }) {
  const app = useApp();
  if (!q.to?.length) return null;
  const names = q.to.map((a) => {
    const name = a.split("~")[0];
    return a === app.name || a === app.address() || name === app.name ? "вы" : (APPS[name] ?? name);
  });
  const sorted = [...new Set(names)].sort((a, b) => (a === "вы" ? -1 : b === "вы" ? 1 : 0));
  return <div className="ask-hint">{`Вопрос видят: ${sorted.join(" и ")}`}</div>;
}

/** Вопрос на экране: первый ждущий, иначе последний с итогом. */
export const shownOf = (qs: Asked[] = []): Asked | undefined => qs.find((q) => !q.done || q.done.word === "failed") ?? qs.at(-1);

export function AskScreen({ params }: { params: Params }) {
  const app = useApp();
  const ask = useModule<Ask>();
  const cs = params.callsign;
  const own = app.use(() => app.current()?.screen === "ask");
  const per = app.use(() => ask.store.get()[cs]);
  const q = shownOf(per?.qs);
  if (!q) {
    if (!own) return null;
    const list = per?.list;
    const text: ReactNode = typeof list === "object" ? `question.list: ${list.error}` : list === "ok" ? `У ${cs} нет ждущих вопросов.` : "Загружаю вопросы…";
    return <div className="ask-empty">{text}</div>;
  }
  const off = !!q.done && q.done.word !== "failed";
  const send = (b: Body) => void ask.answer(cs, q, b);
  const View = q.kind === "perm" ? PermQ : q.kind === "ask" ? AskQ : FormQ;
  return (
    <Pad className="ask" key={q.question}>
      <View cs={cs} q={q} send={send} off={off} />
      {q.kind !== "ask" && <Hint cs={cs} q={q} />}
      {q.done && <Done d={q.done} cs={cs} />}
    </Pad>
  );
}
