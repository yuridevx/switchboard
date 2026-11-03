// Карточка входа: запуск, ссылка и код, итог.
import { useState } from "react";
import { Btn, In, LinkBtn, Note, Opts, PageHead, Sec } from "@switchboard/web-ui";
import { useAccounts } from "./context.ts";
import { say, type Login } from "./store.ts";

/** Ссылка и поле кода: живут на шагах url и code; ошибка убирает их вместе с текстом. */
function CodeForm({ k, l }: { k: string; l: Login }) {
  const store = useAccounts();
  const [value, setValue] = useState("");
  const busy = l.phase === "code";
  return (
    <>
      <div className="ac-link">
        <LinkBtn pri href={l.url ?? "#"} target="_blank" rel="noopener">
          Открыть ссылку входа ↗
        </LinkBtn>
        <Btn onClick={() => void store.copy(l.url ?? "")}>Копировать</Btn>
      </div>
      <Opts>
        <In mono data-f="code" placeholder="Код со страницы" autoComplete="off" disabled={busy} value={value} onInput={(e) => setValue(e.currentTarget.value)} />
        <Btn pri disabled={busy} onClick={() => void store.code(k, value)}>
          Отправить
        </Btn>
      </Opts>
      {busy ? <Note>{`ждём ответа ${l.machine}…`}</Note> : null}
    </>
  );
}

export function LoginCard({ k, l }: { k: string; l: Login }) {
  const store = useAccounts();
  const head = (
    <PageHead>
      <b>{`Вход: ${l.account} на ${l.machine}`}</b>
      <Btn onClick={() => store.hideLogin(k)}>Скрыть</Btn>
    </PageHead>
  );
  if (l.phase === "wait") {
    return (
      <Sec dlg data-login={k}>
        {head}
        <Note>{`Host ${l.machine} запускает вход…`}</Note>
      </Sec>
    );
  }
  if (l.phase === "url" || l.phase === "code") {
    return (
      <Sec dlg data-login={k}>
        {head}
        <CodeForm k={k} l={l} />
      </Sec>
    );
  }
  if (l.phase === "ok") {
    return (
      <Sec tone="ok" data-login={k}>
        {head}
        <b>{`Вошёл: ${l.email} · ${l.plan}`}</b>
      </Sec>
    );
  }
  return (
    <Sec tone="bad" data-login={k}>
      {head}
      <b>{say(l.err ?? "")}</b>
      {l.phase === "bad" ? null : <Note>{`слово: ${l.err}`}</Note>}
      <Opts>
        <Btn pri onClick={() => void store.login(l.machine, l.account)}>
          Войти заново
        </Btn>
      </Opts>
    </Sec>
  );
}
