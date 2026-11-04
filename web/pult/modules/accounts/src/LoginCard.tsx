// Карточка входа по ссылке и коду: запуск, ссылка и код, итог.
import { useState } from "react";
import { Btn, CopyButton, In, LinkBtn, Note, Opts, PageHead, Sec } from "@switchboard/web-ui";
import { say, type Login, useAccounts } from "./store.ts";

/** Ссылка и поле кода: живут на шагах url и code; ошибка убирает их вместе с текстом. */
function CodeForm({ k, login }: { k: string; login: Login }) {
  const store = useAccounts();
  const [code, setCode] = useState("");
  const sending = login.phase === "code";
  return (
    <>
      <div className="ac-link">
        <LinkBtn pri href={login.url ?? "#"} target="_blank" rel="noopener">
          Открыть ссылку входа ↗
        </LinkBtn>
        <CopyButton text={login.url ?? ""} label="Копировать" />
      </div>
      <Opts>
        <In mono data-f="code" placeholder="Код со страницы" autoComplete="off" disabled={sending} value={code} onInput={(e) => setCode(e.currentTarget.value)} />
        <Btn pri disabled={sending} onClick={() => void store.sendCode(k, code)}>
          Отправить
        </Btn>
      </Opts>
      {sending ? <Note>{`ждём ответа ${login.machine}…`}</Note> : null}
    </>
  );
}

export function LoginCard({ k, login }: { k: string; login: Login }) {
  const store = useAccounts();
  const failed = login.phase === "bad" || login.phase === "err";
  return (
    <Sec {...(login.phase === "ok" ? { tone: "ok" as const } : failed ? { tone: "bad" as const } : { dlg: true })} data-login={k}>
      <PageHead>
        <b>{`Вход: ${login.account} на ${login.machine}`}</b>
        <Btn onClick={() => store.hideLogin(k)}>Скрыть</Btn>
      </PageHead>
      {login.phase === "wait" ? <Note>{`Host ${login.machine} запускает вход…`}</Note> : null}
      {login.phase === "url" || login.phase === "code" ? <CodeForm k={k} login={login} /> : null}
      {login.phase === "ok" ? <b>{`Вошёл: ${login.email} · ${login.plan}`}</b> : null}
      {failed ? (
        <>
          <b>{say(login.err ?? "")}</b>
          {login.phase === "bad" ? null : <Note>{`слово: ${login.err}`}</Note>}
          <Opts>
            <Btn pri onClick={() => void store.login(login.machine, login.account)}>
              Войти заново
            </Btn>
          </Opts>
        </>
      ) : null}
    </Sec>
  );
}
