// Вопросы AskUserQuestion: варианты плитками, «Свой ответ» текстом, кнопка ответа. Выбор — местное состояние вопроса.
import { useState } from "react";
import { Cta, In } from "@switchboard/web-ui";
import { useAsk } from "./store.ts";
import { isLocked, type Question, type Rec } from "./store.ts";

export function AskQuestions({ rec }: { rec: Rec }) {
  const ask = useAsk();
  // выбор человека: текст вопроса → выбранные варианты; свой ответ — текстом
  const [picks, setPicks] = useState<Record<string, string[]>>({});
  const [own, setOwn] = useState<Record<string, string>>({});
  const [ownOn, setOwnOn] = useState<string[]>([]);
  const locked = isLocked(rec);

  function answers(): Record<string, string> | null {
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

  const ready = answers();
  return (
    <>
      {rec.questions.map((q, i) => (
        <div key={q.question} className="ask-q">
          {q.header || rec.questions.length > 1 ? (
            <div className="ask-qh">
              {q.header ? <span className="ask-chip">{q.header}</span> : <span />}
              {rec.questions.length > 1 ? <span className="ask-qn">{`вопрос ${i + 1} из ${rec.questions.length}`}</span> : null}
            </div>
          ) : null}
          <div className="ask-qt">{q.question}</div>
          <div className="ask-opts">
            {q.options.map((o) => (
              <button key={o.label} className={q.multiSelect ? "ask-opt multi" : "ask-opt"} aria-pressed={picks[q.question]?.includes(o.label) ? "true" : "false"} disabled={locked} onClick={() => pick(q, o.label)}>
                <span>
                  <b>{o.label}</b>
                  {o.description ? <span>{o.description}</span> : null}
                </span>
              </button>
            ))}
            <button className="ask-opt own" aria-pressed={ownOn.includes(q.question) ? "true" : "false"} disabled={locked} onClick={() => toggleOwn(q)}>
              <span>
                <b>Свой ответ</b>
              </span>
            </button>
            {ownOn.includes(q.question) ? (
              <In className="ask-own" type="text" data-own={q.question} placeholder="Ваш ответ" disabled={locked} autoFocus value={own[q.question] ?? ""} onInput={(e) => setOwn({ ...own, [q.question]: e.currentTarget.value })} />
            ) : null}
          </div>
        </div>
      ))}
      {!locked || rec.status === "sending" ? (
        <Cta
          disabled={!ready || rec.status === "sending"}
          onClick={() => {
            if (ready) void ask.answer(rec, { answers: ready }, ready);
          }}
        >
          {rec.status === "sending" ? "Отправляю…" : "Ответить"}
        </Cta>
      ) : null}
    </>
  );
}
