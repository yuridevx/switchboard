// Запрос разрешения и одобрение плана: что просит Claude и ответы человека. Разрешить «всегда» — только если предложил SDK;
// ответ за человека не выбирается никогда. Причина отказа — местное состояние запроса.
import { useState } from "react";
import { Cta, Markdown, Btn, Area } from "@switchboard/web-ui";
import { useAsk } from "./store.ts";
import { alwaysLines, isPlan, permFrame, subjectOf } from "./perm.ts";
import { isLocked, type Rec } from "./store.ts";

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

export function AskPerm({ rec }: { rec: Rec }) {
  const ask = useAsk();
  const f = permFrame(rec);
  const plan = isPlan(f);
  const [denying, setDenying] = useState(false);
  const [why, setWhy] = useState("");
  const sending = rec.status === "sending";
  const subject = plan ? "" : subjectOf(f);
  const say = (label: string, body: Record<string, unknown>) => void ask.answer(rec, body, { action: label });
  const deny = () => {
    const message = why.trim();
    say(plan ? "Вернуть" : "Отклонить", { action: "deny", ...(message ? { message } : {}) });
  };
  return (
    <>
      <div className="ask-q">
        <div className="ask-qt">{plan ? "План на одобрение" : "Claude просит разрешения"}</div>
        {plan ? (
          <div className="ask-plan">
            <Markdown text={String(f.input.plan ?? "").replace(/^\s*#{1,6}\s*план\s*\n+/i, "")} />
          </div>
        ) : (
          <>
            <div className="ask-qh">
              <span className="ask-chip">{f.displayName ?? f.tool}</span>
            </div>
            {subject ? <code className="ask-subject">{subject}</code> : null}
            {f.title ? <div className="ask-note">{f.title}</div> : null}
            {f.description && f.description !== f.title ? <div className="ask-note">{f.description}</div> : null}
            {f.reason ? <div className="ask-note">{f.reason}</div> : null}
            {f.blockedPath ? <code className="ask-path">{f.blockedPath}</code> : null}
            <FullInput input={f.input} subject={subject} />
          </>
        )}
      </div>
      {isLocked(rec) && !sending ? null : denying ? (
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
            : alwaysLines(f).map((l) => (
                <div className="ask-note" key={l}>
                  {l}
                </div>
              ))}
          <div className="ask-acts">
            <Cta disabled={sending} onClick={() => say(plan ? "Одобрить" : "Разрешить", { action: "allow" })}>
              {plan ? "Одобрить" : "Разрешить"}
            </Cta>
            {plan || f.suggestions?.length ? (
              <Btn type="button" className="ask-decline" disabled={sending} onClick={() => say(plan ? "Одобрить и разрешать правки" : "Разрешать всегда", { action: "allow", always: true })}>
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
