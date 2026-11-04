// Экраны входа и отказа: приложение не работает, причина и что делать. Один экран — один компонент; какой — по записи снимка ядра.
import { useRef, useState } from "react";
import { PROTO } from "@switchboard/relay";
import { Btn, Cmd, Cta, In } from "@switchboard/web-ui";
import type { Stop } from "../state.ts";
import { useCore } from "./core.ts";

function Wipe() {
  const core = useCore();
  return (
    <Cta data-act="wipe" onClick={() => void core.wipe()}>
      Стереть данные приложения
    </Cta>
  );
}

function GateRefused({ errors }: { errors: string[] }) {
  return (
    <>
      <div className="sb-ring bad">×</div>
      <div className="sb-big">Приложение не стартует</div>
      <ul className="sb-errs">
        {errors.map((e) => (
          <li key={e}>{e}</li>
        ))}
      </ul>
    </>
  );
}

function BrowserOld() {
  return (
    <>
      <div className="sb-ring wait">↻</div>
      <div className="sb-big">Браузер устарел</div>
      <p>Приложению нужен браузер с поддержкой @scope. Обновите браузер и откройте страницу снова.</p>
    </>
  );
}

function InstallHere({ number }: { number: string }) {
  return (
    <>
      <div className="sb-logo xl">S</div>
      <div className="sb-big">Добавьте Switchboard на экран «Домой»</div>
      <p>На iPhone уведомления приходят только приложению с экрана «Домой».</p>
      <ol className="sb-ol">
        <li>Нажмите «Поделиться» внизу</li>
        <li>«На экран „Домой“»</li>
        <li>Откройте Switchboard с экрана «Домой»</li>
      </ol>
      <p>{`Приглашение ${number} ждёт в адресе страницы до установки.`}</p>
    </>
  );
}

function PassRefused({ why, kid, command }: { why: "revoked" | "bad_key"; kid: string; command: string }) {
  return (
    <>
      <div className="sb-ring bad">×</div>
      <div className="sb-big">{why === "revoked" ? "Пропуск отозван" : "Пропуск не принят"}</div>
      <p>{`${kid} ${why === "revoked" ? "больше не принимают" : "не принят флотом"}. Новый пропуск — приглашением от агента флота:`}</p>
      <Cmd>{command}</Cmd>
      <p>Откройте ссылку-приглашение в этом приложении. Само приложение больше не подключается.</p>
      <Wipe />
    </>
  );
}

function Outdated() {
  const core = useCore();
  return (
    <>
      <div className="sb-ring wait">↻</div>
      <div className="sb-big">Приложение устарело</div>
      <p>{`У приложения proto ${PROTO}; relay эту версию не принял — его обновили, пока приложение было открыто.`}</p>
      <Cta onClick={core.reload}>Перезагрузить</Cta>
    </>
  );
}

function ConnectionStopped({ why }: { why: string }) {
  const core = useCore();
  return (
    <>
      <div className="sb-ring bad">×</div>
      <div className="sb-big">Связь остановлена</div>
      <p>{`relay закрыл соединение: ${why || "без причины"}.`}</p>
      <Cta onClick={core.reload}>Перезагрузить</Cta>
    </>
  );
}

function InviteRefused({ word }: { word: string }) {
  return (
    <>
      <div className="sb-ring bad">×</div>
      <div className="sb-big">Приглашение не принято</div>
      <p>{word === "bad_invite" ? "Оно уже принято, отозвано или набрано с ошибкой. Попросите агента выдать новое." : `gate не ответил: ${word}. Откройте ссылку ещё раз позже.`}</p>
      <Wipe />
    </>
  );
}

/** Приглашение в адресе при имеющемся пропуске: заменить его может только человек. */
function ReplacePass({ invite, number, kid }: { invite: string; number: string; kid: string }) {
  const core = useCore();
  const [why, setWhy] = useState("");
  return (
    <>
      <div className="sb-ring wait">?</div>
      <div className="sb-big">Заменить пропуск этого устройства?</div>
      <p>{`Ссылка несёт приглашение ${number}. Сейчас устройство входит пропуском ${kid}. Заменяйте, только если сами просили эту ссылку.`}</p>
      <Cta data-act="replace" onClick={async () => setWhy((await core.acceptInvite(invite)) ?? "")}>
        Заменить пропуск
      </Cta>
      <Btn data-act="keep" onClick={core.reload}>
        Оставить текущий
      </Btn>
      <p role="alert">{why}</p>
    </>
  );
}

/** Нужен пропуск: поле приглашения; ядро отвечает причиной отказа или null. */
function KeyPrompt({ command }: { command: string }) {
  const core = useCore();
  const input = useRef<HTMLInputElement>(null);
  const [why, setWhy] = useState("");
  return (
    <>
      <div className="sb-logo xl">S</div>
      <div className="sb-big">Нужен пропуск флота</div>
      <p>Вход — только пропуском. Попросите агента флота выдать приглашение и откройте ссылку в этом приложении:</p>
      <Cmd>{command}</Cmd>
      <p>Или вставьте приглашение:</p>
      <In className="sb-keyin" type="text" placeholder="приглашение или ссылка с #invite=" aria-label="Приглашение" ref={input} />
      <Cta onClick={async () => setWhy((await core.acceptInvite(input.current?.value ?? "")) ?? "")}>Принять приглашение</Cta>
      <p role="alert">{why}</p>
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
