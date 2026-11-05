// Экран «Вам»: карточки по группам; пусто — «Всё разобрано». Каждая карточка выбирает своё и меняется одна.
import { Fragment, memo, type ReactNode } from "react";
import type { SessionRecord } from "@switchboard/web-core";
import { Btn, Dot, failText, hhmm, machineLabel, sessionLabel, sessionOf, slotOf, TextBtn, useApp } from "@switchboard/web-ui";
import { useInbox, type Item, type Kind } from "./state.ts";

const GROUPS = ["Ждут ответа", "Сломалось или ждёт", "Готово"];

/** Заголовок карточки: лампа, позывной (открыть) и что случилось. */
function SessionHead({ s, dot, label }: { s: SessionRecord; dot: string; label: string }) {
  const app = useApp();
  const name = app.use(() => sessionLabel(app, s.callsign).text);
  const project = app.use(() => app.mark("project.of", s.callsign)?.name ?? "");
  return (
    <div className="ib-ih">
      <Dot kind={dot} />
      <TextBtn className="ib-cs" onClick={() => app.open("card", { callsign: s.callsign })}>
        {name}
      </TextBtn>
      <span className="ib-lb">{[label, project].filter(Boolean).join(" · ")}</span>
    </div>
  );
}

function RaiseButton() {
  const app = useApp();
  return (
    <Btn pri onClick={() => app.open("points", {})}>
      Поднять из точки
    </Btn>
  );
}

/** Машина не на связи: подпись и «Поднять из точки», если модуль точек есть. */
function Away({ machine, at, list }: { machine: string; at: number; list: string }) {
  const app = useApp();
  const name = app.use(() => machineLabel(app, machine).text);
  const points = app.use(() => app.mark("fire") !== undefined);
  return (
    <div className="ib-it bad" data-kind="away" data-machine={machine}>
      <div className="ib-ih">
        <Dot kind="gone" />
        <b className="ib-cs">{name}</b>
        <span className="ib-lb">{`не на связи с ${hhmm(at)}`}</span>
      </div>
      <div className="ib-tx">{list}</div>
      {points ? (
        <div className="ib-acts">
          <RaiseButton />
        </div>
      ) : null}
    </div>
  );
}

/** Машины ушли раньше, чем открыто приложение. */
function Fire({ n }: { n: number }) {
  return (
    <div className="ib-it bad" data-kind="fire">
      <div className="ib-ih">
        <Dot kind="gone" />
        <span className="ib-lb">{`машин не на связи: ${n}`}</span>
      </div>
      <div className="ib-acts">
        <RaiseButton />
      </div>
    </div>
  );
}

/** Рамка карточки сессии. */
function Frame({ kind, tone, callsign, children }: { kind: Kind; tone: string; callsign: string; children: ReactNode }) {
  return (
    <div className={`ib-it ${tone}`} data-kind={kind} data-callsign={callsign}>
      {children}
    </div>
  );
}

/** Карточка сессии: своя выборка записи, поэтому меняется только она. */
const SessionCard = memo(function SessionCard({ kind, callsign, at }: { kind: Kind; callsign: string; at?: number }) {
  const app = useApp();
  const inbox = useInbox();
  const s = app.use(() => sessionOf(app, callsign));
  const unread = app.use(() => (kind === "msg" ? app.mark("unread", callsign) : undefined));
  if (!s) return null;
  const open = () => app.open("card", { callsign });
  switch (kind) {
    case "q":
      // вопрос — экраном web-ask в карточке: варианты, свой ответ; первый ответ с любого устройства убирает карточку
      return (
        <Frame kind={kind} tone="you" callsign={callsign}>
          <SessionHead s={s} dot="wait" label="спрашивает" />
          <div className="ib-q">
            <app.Slot screen="ask" params={{ callsign }} />
          </div>
        </Frame>
      );
    case "msg":
      return (
        <Frame kind={kind} tone="you" callsign={callsign}>
          <SessionHead s={s} dot="wait" label="пишет вам" />
          <div className="ib-tx">{unread?.text}</div>
          <div className="ib-acts">
            <Btn pri onClick={open}>
              Открыть
            </Btn>
          </div>
        </Frame>
      );
    case "fail": {
      const why = failText(s);
      return (
        <Frame kind={kind} tone="bad" callsign={callsign}>
          <SessionHead s={s} dot="bad" label="не запустилась" />
          {why ? <div className="ib-tx">{why}</div> : null}
          <div className="ib-acts">
            <Btn pri onClick={() => void inbox.restart(callsign)}>
              Запустить снова
            </Btn>
            <Btn onClick={open}>Почему</Btn>
          </div>
        </Frame>
      );
    }
    case "wait":
      return (
        <Frame kind={kind} tone="bad" callsign={callsign}>
          <SessionHead s={s} dot="idle" label="ждёт сброса лимита" />
          <div className="ib-tx">{`Аккаунты слота ${slotOf(s)?.name ?? ""} у порога — продолжит после ${hhmm(at!)}`}</div>
          <div className="ib-acts">
            <Btn onClick={open}>Открыть</Btn>
          </div>
        </Frame>
      );
    default:
      return (
        <Frame kind={kind} tone="done" callsign={callsign}>
          <SessionHead s={s} dot="idle" label="готово" />
          <div className="ib-acts">
            <Btn onClick={open}>Открыть</Btn>
            <Btn ghost onClick={() => inbox.seen(callsign)}>
              Прочитано
            </Btn>
          </div>
        </Frame>
      );
  }
});

function Card({ it }: { it: Item }) {
  if (it.kind === "away") return <Away machine={it.machine!} at={it.at!} list={it.list!} />;
  if (it.kind === "fire") return <Fire n={it.n!} />;
  return <SessionCard kind={it.kind} callsign={it.callsign!} at={it.at} />;
}

export function InboxScreen() {
  const app = useApp();
  const inbox = useInbox();
  const list = app.use(inbox.items);
  const root = "ib" + (app.wide ? " wide" : "");
  if (!list.length) {
    return (
      <div className={root}>
        <div className="ib-empty">
          <b>Всё разобрано</b>
        </div>
      </div>
    );
  }
  return (
    <div className={root}>
      {GROUPS.map((title, g) => {
        const xs = list.filter((x) => x.g === g);
        if (!xs.length) return null;
        return (
          <Fragment key={title}>
            <div className="ib-gh">{`${title} · ${xs.length}`}</div>
            {xs.map((x) => (
              <Card key={`${x.kind}:${x.callsign ?? x.machine ?? "fire"}`} it={x} />
            ))}
          </Fragment>
        );
      })}
    </div>
  );
}
