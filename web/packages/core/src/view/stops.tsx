// Экраны входа и отказа: приложение не работает, причина и что делать. Один экран — один компонент; какой — по записи снимка ядра.
import { useRef, useState } from "react";
import { PROTO } from "@switchboard/relay";
import { Btn, Cmd, Cta, In } from "@switchboard/web-ui";
import type { Stop } from "../snapshot.ts";
import { useCore } from "./context.ts";

const Ring = ({ tone, mark }: { tone: "bad" | "wait"; mark: string }) => <div className={`sb-ring ${tone}`}>{mark}</div>;
const Big = ({ children }: { children: string }) => <div className="sb-big">{children}</div>;
const Logo = () => <div className="sb-logo xl">S</div>;

function Wipe() {
  const { halt } = useCore();
  return (
    <Cta data-act="wipe" onClick={() => void halt.wipe()}>
      Стереть данные приложения
    </Cta>
  );
}

function Reload() {
  const { win } = useCore();
  return <Cta onClick={() => win.location.reload()}>Перезагрузить</Cta>;
}

const GateRefused = ({ errors }: { errors: string[] }) => (
  <>
    <Ring tone="bad" mark="×" />
    <Big>Приложение не стартует</Big>
    <ul className="sb-errs">
      {errors.map((e) => (
        <li key={e}>{e}</li>
      ))}
    </ul>
  </>
);

const BrowserOld = () => (
  <>
    <Ring tone="wait" mark="↻" />
    <Big>Браузер устарел</Big>
    <p>Приложению нужен браузер с поддержкой @scope. Обновите браузер и откройте страницу снова.</p>
  </>
);

const InstallHere = ({ number }: { number: string }) => (
  <>
    <Logo />
    <Big>Добавьте Switchboard на экран «Домой»</Big>
    <p>На iPhone уведомления приходят только приложению с экрана «Домой».</p>
    <ol className="sb-ol">
      <li>Нажмите «Поделиться» внизу</li>
      <li>«На экран „Домой“»</li>
      <li>Откройте Switchboard с экрана «Домой»</li>
    </ol>
    <p>{`Приглашение ${number} ждёт в адресе страницы до установки.`}</p>
  </>
);

function PassRefused({ why, kid, command }: { why: "revoked" | "bad_key"; kid: string; command: string }) {
  const revoked = why === "revoked";
  return (
    <>
      <Ring tone="bad" mark="×" />
      <Big>{revoked ? "Пропуск отозван" : "Пропуск не принят"}</Big>
      <p>{`${kid} ${revoked ? "больше не принимают" : "не принят флотом"}. Новый пропуск — приглашением от агента флота:`}</p>
      <Cmd>{command}</Cmd>
      <p>Откройте ссылку-приглашение в этом приложении. Само приложение больше не подключается.</p>
      <Wipe />
    </>
  );
}

const Outdated = () => (
  <>
    <Ring tone="wait" mark="↻" />
    <Big>Приложение устарело</Big>
    <p>{`У приложения proto ${PROTO}; relay эту версию не принял — его обновили, пока приложение было открыто.`}</p>
    <Reload />
  </>
);

const ConnectionStopped = ({ why }: { why: string }) => (
  <>
    <Ring tone="bad" mark="×" />
    <Big>Связь остановлена</Big>
    <p>{`relay закрыл соединение: ${why || "без причины"}.`}</p>
    <Reload />
  </>
);

const InviteRefused = ({ word }: { word: string }) => (
  <>
    <Ring tone="bad" mark="×" />
    <Big>Приглашение не принято</Big>
    <p>{word === "bad_invite" ? "Оно уже принято, отозвано или набрано с ошибкой. Попросите агента выдать новое." : `gate не ответил: ${word}. Откройте ссылку ещё раз позже.`}</p>
    <Wipe />
  </>
);

/** Приглашение в адресе при имеющемся пропуске: заменить его может только человек. */
function ReplacePass({ invite, number, kid }: { invite: string; number: string; kid: string }) {
  const { halt, win } = useCore();
  const [refusal, setRefusal] = useState("");
  return (
    <>
      <Ring tone="wait" mark="?" />
      <Big>Заменить пропуск этого устройства?</Big>
      <p>{`Ссылка несёт приглашение ${number}. Сейчас устройство входит пропуском ${kid}. Заменяйте, только если сами просили эту ссылку.`}</p>
      <Cta data-act="replace" onClick={async () => setRefusal((await halt.acceptInvite(invite)) ?? "")}>
        Заменить пропуск
      </Cta>
      <Btn data-act="keep" onClick={() => win.location.reload()}>
        Оставить текущий
      </Btn>
      <p role="alert">{refusal}</p>
    </>
  );
}

/** Нужен пропуск: поле приглашения. */
function KeyPrompt({ command }: { command: string }) {
  const { halt } = useCore();
  const input = useRef<HTMLInputElement>(null);
  const [refusal, setRefusal] = useState("");
  return (
    <>
      <Logo />
      <Big>Нужен пропуск флота</Big>
      <p>Вход — только пропуском. Попросите агента флота выдать приглашение и откройте ссылку в этом приложении:</p>
      <Cmd>{command}</Cmd>
      <p>Или вставьте приглашение:</p>
      <In className="sb-keyin" type="text" placeholder="приглашение или ссылка с #invite=" aria-label="Приглашение" ref={input} />
      <Cta onClick={async () => setRefusal((await halt.acceptInvite(input.current?.value ?? "")) ?? "")}>Принять приглашение</Cta>
      <p role="alert">{refusal}</p>
    </>
  );
}

export function StopScreen({ stop }: { stop: Stop }) {
  switch (stop.kind) {
    case "gate":
      return <GateRefused errors={stop.errors} />;
    case "browser":
      return <BrowserOld />;
    case "install":
      return <InstallHere number={stop.number} />;
    case "pass":
      return <PassRefused why={stop.why} kid={stop.kid} command={stop.command} />;
    case "outdated":
      return <Outdated />;
    case "connection":
      return <ConnectionStopped why={stop.why} />;
    case "invite":
      return <InviteRefused word={stop.word} />;
    case "replace":
      return <ReplacePass invite={stop.invite} number={stop.number} kid={stop.kid} />;
    case "key":
      return <KeyPrompt command={stop.command} />;
  }
}
