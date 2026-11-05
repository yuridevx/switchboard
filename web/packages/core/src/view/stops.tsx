// Экраны, где приложение не работает: остановка, отказ, вход. Вид решает только, что сказать по слову остановки.
import { useRef, useState, type ReactNode } from "react";
import { PROTO } from "@switchboard/relay";
import { Btn, Cmd, Cta, In } from "@switchboard/web-ui";
import { inviteIn, keyId, nameInKey, numberOf } from "../pass.ts";
import type { Page } from "./shell.tsx";

const Ring = ({ kind, children }: { kind: "bad" | "wait"; children: string }) => <div className={`sb-ring ${kind}`}>{children}</div>;
const Logo = () => <div className="sb-logo xl">S</div>;
const Big = ({ children }: { children: ReactNode }) => <div className="sb-big">{children}</div>;
const Wipe = ({ page }: { page: Page }) => (
  <Cta data-act="wipe" onClick={() => void page.wipe()}>
    Стереть данные приложения
  </Cta>
);
const Reload = ({ page }: { page: Page }) => <Cta onClick={page.reload}>Перезагрузить</Cta>;
const ACCEPTED = "Откройте ссылку-приглашение в этом приложении. Само приложение больше не подключается.";

/** Вставленное приглашение: принято — перезагрузка; отказ — словом. */
function Paste({ page }: { page: Page }) {
  const input = useRef<HTMLInputElement>(null);
  const [word, setWord] = useState("");
  const accept = async () => {
    const invite = inviteIn(input.current!.value);
    if (!invite) return setWord("Это не приглашение: нужен <номер>.<секрет> или ссылка с #invite=.");
    const refused = await page.accept(invite);
    if (refused) setWord(`Приглашение не принято: ${refused}.`);
    else page.reload();
  };
  return (
    <>
      <In ref={input} type="text" className="sb-keyin" placeholder="приглашение или ссылка с #invite=" aria-label="Приглашение" />
      <Cta onClick={() => void accept()}>Принять приглашение</Cta>
      <p role="alert">{word}</p>
    </>
  );
}

/** Чужое приглашение при своём пропуске: заменить или оставить. */
function Replace({ page, invite }: { page: Page; invite: string }) {
  const [word, setWord] = useState("");
  const replace = async () => {
    const refused = await page.accept(invite);
    if (refused) setWord(`Приглашение не принято: ${refused}.`);
    else page.reload();
  };
  return (
    <>
      <Cta data-act="replace" onClick={() => void replace()}>
        Заменить пропуск
      </Cta>
      <Btn data-act="keep" onClick={page.reload}>
        Оставить текущий
      </Btn>
      <p role="alert">{word}</p>
    </>
  );
}

/** Содержимое экрана остановки по её слову. */
export function stopScreen(page: Page, why: string): ReactNode {
  const { core, wide } = page;
  const id = core.key ? keyId(core.key) : "";
  const person = core.key ? nameInKey(core.key) : wide ? "<имя>" : "phone";
  const command = <Cmd>{`keys.invite client ${person} <почта>`}</Cmd>;
  switch (why) {
    case "browser":
      return (
        <>
          <Ring kind="wait">↻</Ring>
          <Big>Браузер устарел</Big>
          <p>Приложению нужен браузер с поддержкой @scope. Обновите браузер и откройте страницу снова.</p>
        </>
      );
    case "gate":
      return (
        <>
          <Ring kind="bad">×</Ring>
          <Big>Приложение не стартует</Big>
          <ul className="sb-errs">
            {core.errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </>
      );
    case "install":
      return (
        <>
          <Logo />
          <Big>Добавьте Switchboard на экран «Домой»</Big>
          <p>На iPhone уведомления приходят только приложению с экрана «Домой».</p>
          <ol className="sb-ol">
            <li>Нажмите «Поделиться» внизу</li>
            <li>«На экран „Домой“»</li>
            <li>Откройте Switchboard с экрана «Домой»</li>
          </ol>
          <p>{`Приглашение ${numberOf(core.invite!)} ждёт в адресе страницы до установки.`}</p>
        </>
      );
    case "no_key":
      return (
        <>
          <Logo />
          <Big>Нужен пропуск флота</Big>
          <p>Вход — только пропуском. Попросите агента флота выдать приглашение и откройте ссылку в этом приложении:</p>
          {command}
          <p>Или вставьте приглашение:</p>
          <Paste page={page} />
        </>
      );
    case "replace":
      return (
        <>
          <Ring kind="wait">?</Ring>
          <Big>Заменить пропуск этого устройства?</Big>
          <p>{`Ссылка несёт приглашение ${numberOf(core.invite!)}. Сейчас устройство входит пропуском ${id}. Заменяйте, только если сами просили эту ссылку.`}</p>
          <Replace page={page} invite={core.invite!} />
        </>
      );
    case "revoked":
    case "bad_key":
      return (
        <>
          <Ring kind="bad">×</Ring>
          <Big>{why === "revoked" ? "Пропуск отозван" : "Пропуск не принят"}</Big>
          <p>{`${id} ${why === "revoked" ? "больше не принимают" : "не принят флотом"}. Новый пропуск — приглашением от агента флота:`}</p>
          {command}
          <p>{ACCEPTED}</p>
          <Wipe page={page} />
        </>
      );
    case "contract_mismatch":
      return (
        <>
          <Ring kind="wait">↻</Ring>
          <Big>Приложение устарело</Big>
          <p>{`У приложения proto ${PROTO}; relay эту версию не принял — его обновили, пока приложение было открыто.`}</p>
          <Reload page={page} />
        </>
      );
  }
  // слово gate на приглашении из адреса
  if (core.invite) {
    return (
      <>
        <Ring kind="bad">×</Ring>
        <Big>Приглашение не принято</Big>
        <p>{why === "bad_invite" ? "Оно уже принято, отозвано или набрано с ошибкой. Попросите агента выдать новое." : `gate не ответил: ${why}. Откройте ссылку ещё раз позже.`}</p>
        <Wipe page={page} />
      </>
    );
  }
  return (
    <>
      <Ring kind="bad">×</Ring>
      <Big>Связь остановлена</Big>
      <p>{`relay закрыл соединение: ${why || "без причины"}.`}</p>
      <Reload page={page} />
    </>
  );
}

/** Экран подключения: до первого roster. */
export function Connecting({ page }: { page: Page }) {
  const key = page.bus.use(() => page.core.key);
  const invited = page.bus.use(() => page.core.invited);
  return (
    <>
      <Logo />
      {invited && <Big>Ключ сохранён</Big>}
      {key && <span className="sb-k">{keyId(key)}</span>}
      <p>подключаюсь · hello</p>
    </>
  );
}
