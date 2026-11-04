// Карточки «Вам»: вопрос, сообщение, сбой, ожидание лимита, готово, ушедшая машина. Каждая выбирает своё и меняется одна.
import { memo } from "react";
import type { SessionRecord } from "@switchboard/web-core";
import { Dot, failText, hhmm, machineLabel, sessionLabel, sessionOf, useApp } from "@switchboard/web-ui";
import { useInbox } from "./store.ts";
import type { Item, Kind } from "./store.ts";

/** Заголовок карточки: лампа, позывной (открыть) и что случилось. */
function CardHead({ s, dot, label }: { s: SessionRecord; dot: string; label: string }) {
  const app = useApp();
  const name = app.use(() => sessionLabel(app, s.callsign).text);
  const project = app.use(() => app.mark("project.of", s.callsign)?.name ?? "");
  return (
    <div className="ib-ih">
      <Dot kind={dot} />
      <button className="ib-cs" onClick={() => app.open("card", { callsign: s.callsign })}>
        {name}
      </button>
      <span className="ib-lb">{[label, project].filter(Boolean).join(" · ")}</span>
    </div>
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
          <button className="pri" onClick={() => app.open("points", {})}>
            Поднять из точки
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** Машины ушли раньше, чем открыто приложение. */
function Fire({ n }: { n: number }) {
  const app = useApp();
  return (
    <div className="ib-it bad" data-kind="fire">
      <div className="ib-ih">
        <Dot kind="gone" />
        <span className="ib-lb">{`машин не на связи: ${n}`}</span>
      </div>
      <div className="ib-acts">
        <button className="pri" onClick={() => app.open("points", {})}>
          Поднять из точки
        </button>
      </div>
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
        <div className="ib-it you" data-kind="q" data-callsign={callsign}>
          <CardHead s={s} dot="wait" label="спрашивает" />
          <div className="ib-q">
            <app.Slot screen="ask" params={{ callsign }} />
          </div>
        </div>
      );
    case "msg":
      return (
        <div className="ib-it you" data-kind="msg" data-callsign={callsign}>
          <CardHead s={s} dot="wait" label="пишет вам" />
          <div className="ib-tx">{unread?.text}</div>
          <div className="ib-acts">
            <button className="pri" onClick={open}>
              Открыть
            </button>
          </div>
        </div>
      );
    case "fail": {
      const why = failText(s);
      return (
        <div className="ib-it bad" data-kind="fail" data-callsign={callsign}>
          <CardHead s={s} dot="bad" label="не запустилась" />
          {why ? <div className="ib-tx">{why}</div> : null}
          <div className="ib-acts">
            <button className="pri" onClick={() => void inbox.restart(callsign)}>
              Запустить снова
            </button>
            <button onClick={open}>Почему</button>
          </div>
        </div>
      );
    }
    case "wait": {
      const slot = (s.slot as { name?: string }).name ?? "";
      return (
        <div className="ib-it bad" data-kind="wait" data-callsign={callsign}>
          <CardHead s={s} dot="idle" label="ждёт сброса лимита" />
          <div className="ib-tx">{`Аккаунты слота ${slot} у порога — продолжит после ${hhmm(at!)}`}</div>
          <div className="ib-acts">
            <button onClick={open}>Открыть</button>
          </div>
        </div>
      );
    }
    default:
      return (
        <div className="ib-it done" data-kind="done" data-callsign={callsign}>
          <CardHead s={s} dot="idle" label="готово" />
          <div className="ib-acts">
            <button onClick={open}>Открыть</button>
            <button className="ghost" onClick={() => inbox.markSeen(callsign)}>
              Прочитано
            </button>
          </div>
        </div>
      );
  }
});

export function InboxCard({ it }: { it: Item }) {
  if (it.kind === "away") return <Away machine={it.machine!} at={it.at!} list={it.list!} />;
  if (it.kind === "fire") return <Fire n={it.n!} />;
  return <SessionCard kind={it.kind} callsign={it.callsign!} at={it.at} />;
}
