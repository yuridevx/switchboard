// Экраны входа и отказа: приложение не работает, причина и что делать. Один экран — одна функция.
import { useRef, useState } from "react";
import { PROTO } from "@switchboard/relay";
import { Cmd, Cta } from "@switchboard/web-ui";

function Wipe({ run }: { run(): void }) {
  return (
    <Cta data-act="wipe" onClick={run}>
      Стереть данные приложения
    </Cta>
  );
}

export function gateRefused(errors: string[]) {
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

export function browserOld() {
  return (
    <>
      <div className="sb-ring wait">↻</div>
      <div className="sb-big">Браузер устарел</div>
      <p>Приложению нужен браузер с поддержкой @scope. Обновите браузер и откройте страницу снова.</p>
    </>
  );
}

export function installHere(number: string) {
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

export function passRefused(why: "revoked" | "bad_key", kid: string, command: string, wipe: () => void) {
  return (
    <>
      <div className="sb-ring bad">×</div>
      <div className="sb-big">{why === "revoked" ? "Пропуск отозван" : "Пропуск не принят"}</div>
      <p>{`${kid} ${why === "revoked" ? "больше не принимают" : "не принят флотом"}. Новый пропуск — приглашением от агента флота:`}</p>
      <Cmd>{command}</Cmd>
      <p>Откройте ссылку-приглашение в этом приложении. Само приложение больше не подключается.</p>
      <Wipe run={wipe} />
    </>
  );
}

export function outdated(reload: () => void) {
  return (
    <>
      <div className="sb-ring wait">↻</div>
      <div className="sb-big">Приложение устарело</div>
      <p>{`У приложения proto ${PROTO}; relay эту версию не принял — его обновили, пока приложение было открыто.`}</p>
      <Cta onClick={reload}>Перезагрузить</Cta>
    </>
  );
}

export function connectionStopped(why: string, reload: () => void) {
  return (
    <>
      <div className="sb-ring bad">×</div>
      <div className="sb-big">Связь остановлена</div>
      <p>{`relay закрыл соединение: ${why || "без причины"}.`}</p>
      <Cta onClick={reload}>Перезагрузить</Cta>
    </>
  );
}

export function inviteRefused(word: string, wipe: () => void) {
  return (
    <>
      <div className="sb-ring bad">×</div>
      <div className="sb-big">Приглашение не принято</div>
      <p>{word === "bad_invite" ? "Оно уже принято, отозвано или набрано с ошибкой. Попросите агента выдать новое." : `gate не ответил: ${word}. Откройте ссылку ещё раз позже.`}</p>
      <Wipe run={wipe} />
    </>
  );
}

/** Нужен пропуск: поле приглашения; accept отвечает причиной отказа или null. */
export function KeyPrompt({ command, accept }: { command: string; accept(value: string): Promise<string | null> }) {
  const input = useRef<HTMLInputElement>(null);
  const [why, setWhy] = useState("");
  return (
    <>
      <div className="sb-logo xl">S</div>
      <div className="sb-big">Нужен пропуск флота</div>
      <p>Вход — только пропуском. Попросите агента флота выдать приглашение и откройте ссылку в этом приложении:</p>
      <Cmd>{command}</Cmd>
      <p>Или вставьте приглашение:</p>
      <input className="sb-keyin" type="text" placeholder="приглашение или ссылка с #invite=" aria-label="Приглашение" ref={input} />
      <Cta onClick={async () => setWhy((await accept(input.current?.value ?? "")) ?? "")}>Принять приглашение</Cta>
      <p role="alert">{why}</p>
    </>
  );
}
