// Карточка входа: ссылка и код. Код — только в поле, ушёл машине и забыт.
import { useState } from "react";
import { BadCard, Btn, H4, In, Note, OkCard, Opts, Sec } from "@switchboard/web-ui";
import { type LoginCard, useAccounts } from "./state.ts";

export function LoginCardView({ id, card }: { id: string; card: LoginCard }) {
  const state = useAccounts();
  const [code, setCode] = useState("");
  const waiting = !card.url && !card.failed && !card.done;
  return (
    <Sec data-login={id}>
      <H4>{`Вход: ${card.account} на ${card.machine}`}</H4>
      {waiting ? <Note>{`Host ${card.machine} запускает вход…`}</Note> : null}
      {card.url ? (
        <>
          <div className="ac-link">
            <a className="sb-b pri" href={card.url} target="_blank" rel="noopener">
              Открыть ссылку входа ↗
            </a>
            <Btn onClick={() => void navigator.clipboard?.writeText(card.url!)}>Копировать</Btn>
          </div>
          <Opts>
            <In mono data-f="code" placeholder="Код со страницы" autoComplete="off" value={code} disabled={card.sending} onInput={(e) => setCode(e.currentTarget.value)} />
            <Btn pri disabled={card.sending} onClick={() => void state.sendCode(id, code)}>
              Отправить
            </Btn>
          </Opts>
          {card.sending ? <Note>{`ждём ответа ${card.machine}…`}</Note> : null}
        </>
      ) : null}
      {card.done ? <OkCard role="status">{card.done}</OkCard> : null}
      {card.failed ? (
        <BadCard role="alert">
          <b>{card.failed}</b>
          <span>{`слово: ${card.word}`}</span>
        </BadCard>
      ) : null}
      <Opts>
        {card.failed ? <Btn onClick={() => void state.beginLogin(card.machine, card.account)}>Войти заново</Btn> : null}
        <Btn onClick={() => state.hideLogin(id)}>Скрыть</Btn>
      </Opts>
    </Sec>
  );
}
