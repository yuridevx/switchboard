// Экран вопроса сессии: вопрос или форма, итог ответа и кто ещё видит вопрос. Выбор человека живёт в компоненте вопроса:
// другой вопрос — другой ключ, выбор начат заново.
import { useEffect } from "react";
import type { ScreenProps } from "@switchboard/web-core";
import { BadCard, OkCard, Pad, WaitCard, useApp } from "@switchboard/web-ui";
import { AskForm } from "./AskForm.tsx";
import { AskPerm } from "./AskPerm.tsx";
import { AskQuestions } from "./AskQuestions.tsx";
import { useAsk } from "./context.ts";
import type { Rec } from "./store.ts";

function Result({ rec }: { rec: Rec }) {
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

export function AskScreen({ params }: ScreenProps) {
  const callsign = params.callsign ?? "";
  const app = useApp();
  const ask = useAsk();
  const r = app.use(() => ask.current(callsign));
  const loading = app.use(() => ask.isLoading(callsign));
  const refused = app.use(() => ask.refusedOf(callsign));

  useEffect(() => void ask.list(callsign, true), [ask, callsign]);

  if (!r) {
    return (
      <Pad>
        <div className="ask-empty">{loading ? "Загружаю вопросы…" : refused ? `question.list: ${refused}` : `У ${callsign} нет ждущих вопросов.`}</div>
      </Pad>
    );
  }
  const others = ask.othersOf(r);
  return (
    <Pad className="ask">
      {r.kind === "form" ? <AskForm key={r.id} rec={r} /> : r.kind === "perm" ? <AskPerm key={r.id} rec={r} /> : <AskQuestions key={r.id} rec={r} />}
      <Result rec={r} />
      {r.to.length ? <div className="ask-hint">{`Вопрос видят: вы${others.length ? ` и ${others.join(", ")}` : ""}`}</div> : null}
    </Pad>
  );
}
