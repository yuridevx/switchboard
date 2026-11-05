// Экраны вместо работы: подключение, вход, отказы.
import { useRef, type ReactNode } from "react";
import { Btn, Cmd, Cta, In } from "@switchboard/web-ui";
import { PROTO } from "@switchboard/relay";
import { inviteNumber, keyId } from "../pass.ts";
import { useCore } from "./place.tsx";

const Logo = () => <div className="sb-logo xl">S</div>;
const Ring = ({ tone, children }: { tone: "bad" | "wait"; children: string }) => <div className={`sb-ring ${tone}`}>{children}</div>;
const Full = ({ children }: { children: ReactNode }) => <div className="sb-full">{children}</div>;
const invite = (who: string) => `keys.invite client ${who} <почта>`;

const Wipe = () => {
  const { pass } = useCore();
  return (
    <Cta data-act="wipe" onClick={pass.wipe}>
      Стереть данные приложения
    </Cta>
  );
};

const Reload = () => {
  const { page } = useCore();
  return <Cta onClick={() => page.win.location.reload()}>Перезагрузить</Cta>;
};

function NoKey() {
  const { page, pass } = useCore();
  const note = page.use(() => page.note);
  const input = useRef<HTMLInputElement>(null);
  return (
    <Full>
      <Logo />
      <div className="sb-big">Нужен пропуск флота</div>
      <p>Вход — только пропуском. Попросите агента флота выдать приглашение и откройте ссылку в этом приложении:</p>
      <Cmd>{invite(page.wide ? "<имя>" : "phone")}</Cmd>
      <p>Или вставьте приглашение:</p>
      <In ref={input} className="sb-keyin" type="text" aria-label="Приглашение" placeholder="приглашение или ссылка с #invite=" />
      <Cta onClick={() => pass.paste(input.current!.value)}>Принять приглашение</Cta>
      <p role="alert">{note}</p>
    </Full>
  );
}

function Replace() {
  const { page, pass } = useCore();
  const note = page.use(() => page.note);
  return (
    <Full>
      <Ring tone="wait">?</Ring>
      <div className="sb-big">Заменить пропуск этого устройства?</div>
      <p>{`Ссылка несёт приглашение ${inviteNumber(page.invite!)}. Сейчас устройство входит пропуском ${keyId(page.key!)}. Заменяйте, только если сами просили эту ссылку.`}</p>
      <Cta data-act="replace" onClick={pass.replace}>
        Заменить пропуск
      </Cta>
      <Btn data-act="keep" onClick={() => page.win.location.reload()}>
        Оставить текущий
      </Btn>
      <p role="alert">{note}</p>
    </Full>
  );
}

const Install = ({ number }: { number: string }) => (
  <Full>
    <Logo />
    <div className="sb-big">Добавьте Switchboard на экран «Домой»</div>
    <p>На iPhone уведомления приходят только приложению с экрана «Домой».</p>
    <ol className="sb-ol">
      <li>Нажмите «Поделиться» внизу</li>
      <li>«На экран „Домой“»</li>
      <li>Откройте Switchboard с экрана «Домой»</li>
    </ol>
    <p>{`Приглашение ${number} ждёт в адресе страницы до установки.`}</p>
  </Full>
);

const REFUSED: Record<string, { title: string; text: string }> = {
  revoked: { title: "Пропуск отозван", text: "больше не принимают" },
  bad_key: { title: "Пропуск не принят", text: "не принят флотом" },
};

/** Пропуск отказан: как получить новый. */
const Refused = ({ word, pass }: { word: string; pass: string }) => (
  <Full>
    <Ring tone="bad">×</Ring>
    <div className="sb-big">{REFUSED[word].title}</div>
    <p>{`${keyId(pass)} ${REFUSED[word].text}. Новый пропуск — приглашением от агента флота:`}</p>
    <Cmd>{invite(pass.split(".")[1])}</Cmd>
    <p>Откройте ссылку-приглашение в этом приложении. Само приложение больше не подключается.</p>
    <Wipe />
  </Full>
);

/** Экран остановки по слову. */
function Stopped({ word, inviteRefused }: { word: string; inviteRefused?: boolean }) {
  const { page } = useCore();
  if (inviteRefused) {
    return (
      <Full>
        <Ring tone="bad">×</Ring>
        <div className="sb-big">Приглашение не принято</div>
        <p>{word === "bad_invite" ? "Оно уже принято, отозвано или набрано с ошибкой. Попросите агента выдать новое." : `gate не ответил: ${word}. Откройте ссылку ещё раз позже.`}</p>
        <Wipe />
      </Full>
    );
  }
  if (word === "no_key") return <NoKey />;
  if (word === "replace") return <Replace />;
  if (word === "install") return <Install number={inviteNumber(page.invite ?? "")} />;
  if (REFUSED[word]) return <Refused word={word} pass={page.key!} />;
  if (word === "gate") {
    return (
      <Full>
        <Ring tone="bad">×</Ring>
        <div className="sb-big">Приложение не стартует</div>
        <ul className="sb-errs">
          {page.errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      </Full>
    );
  }
  if (word === "browser") {
    return (
      <Full>
        <Ring tone="wait">↻</Ring>
        <div className="sb-big">Браузер устарел</div>
        <p>Приложению нужен браузер с поддержкой @scope. Обновите браузер и откройте страницу снова.</p>
      </Full>
    );
  }
  if (word === "contract_mismatch") {
    return (
      <Full>
        <Ring tone="wait">↻</Ring>
        <div className="sb-big">Приложение устарело</div>
        <p>{`У приложения proto ${PROTO}; relay эту версию не принял — его обновили, пока приложение было открыто.`}</p>
        <Reload />
      </Full>
    );
  }
  return (
    <Full>
      <Ring tone="bad">×</Ring>
      <div className="sb-big">Связь остановлена</div>
      <p>{`relay закрыл соединение: ${word || "без причины"}.`}</p>
      <Reload />
    </Full>
  );
}

/** Подключение и остановка. */
export function Stops() {
  const { page } = useCore();
  const v = page.use(() => ({ stop: page.stop, key: page.key, saved: page.saved }));
  if (v.stop) return <Stopped word={v.stop.word} inviteRefused={v.stop.invite} />;
  return (
    <Full>
      <Logo />
      {v.saved && <div className="sb-big">Ключ сохранён</div>}
      <span className="sb-k">{v.key && keyId(v.key)}</span>
      <p>подключаюсь · hello</p>
    </Full>
  );
}
