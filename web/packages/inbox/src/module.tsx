// web-inbox — «Вам»: что ждёт вас. Карточки — из roster и меток других модулей; очереди и хранилища нет.
// Своя память — только то, что видно по смене roster при открытом приложении: «готово» (busy → idle) и ушедшие машины.
import { memo } from "react";
import type { App, AppModule, Roster, SessionRecord } from "@switchboard/web-core";
import type {} from "@switchboard/web-ask";
import type {} from "@switchboard/web-board";
import type {} from "@switchboard/web-chat";
import type {} from "@switchboard/web-labels";
import { machineOf } from "@switchboard/protocol";
import { Dot, hhmm } from "@switchboard/web-ui";
import css from "./inbox.css";

type Kind = "q" | "msg" | "fail" | "wait" | "away" | "fire" | "done";
/** Карточка: только простые поля — строка списка перерисовывается, когда изменились они или её выборка. */
type Item = { kind: Kind; g: 0 | 1 | 2; callsign?: string; machine?: string; at?: number; list?: string; n?: number };
const GROUPS = ["Ждут ответа", "Сломалось или ждёт", "Готово"];

/** Новый модуль со своей памятью (в выпуске — один; в тестах — на каждый прогон). */
export function createInbox(): AppModule {
  let app: App;
  let last: Roster | null = null;
  /** закончили ход, пока их не смотрели: позывной */
  const done = new Set<string>();
  /** машины, пропавшие из roster при открытом приложении: машина → когда и её сессии */
  const gone = new Map<string, { at: number; list: SessionRecord[] }>();
  /** «прочитано» на карточке «готово» — до следующего хода */
  const seen = new Set<string>();
  /** мои сессии по прошлому roster: сессий ушедшей машины в roster уже нет, «моё» о них — отсюда */
  let wasMine = new Set<string>();

  const viewing = (callsign: string) => {
    const c = app.current();
    return !!c && c.params.callsign === callsign && c.screen !== "inbox";
  };
  const mine = (callsign: string) => !!app.mark("mine", callsign);

  function onRoster(r: Roster) {
    const before = new Map((last?.sessions ?? []).map((s) => [s.callsign, s.state]));
    for (const s of r.sessions) {
      const was = before.get(s.callsign);
      if (s.state === "busy" || s.state === "starting" || s.state === "waiting") {
        done.delete(s.callsign);
        seen.delete(s.callsign);
      } else if ((was === "busy" || was === "starting") && s.state === "idle" && !viewing(s.callsign)) done.add(s.callsign);
    }
    const now = new Set(r.machines.map((m) => m.machine));
    for (const m of now) gone.delete(m);
    for (const m of last?.machines ?? []) {
      if (!now.has(m.machine)) gone.set(m.machine, { at: Date.now(), list: last!.sessions.filter((s) => machineOf(s.callsign) === m.machine && wasMine.has(s.callsign)) });
    }
    wasMine = new Set(r.sessions.filter((s) => mine(s.callsign)).map((s) => s.callsign));
    last = r;
  }

  /** Карточки сейчас: из roster, меток и того, что видно по смене roster. */
  function items(): Item[] {
    const out: Item[] = [];
    const r = app?.roster();
    if (!r) return out;
    for (const s of r.sessions) {
      const callsign = s.callsign;
      if (app.mark("asked", callsign)) out.push({ kind: "q", g: 0, callsign });
      else if (app.mark("unread", callsign)) out.push({ kind: "msg", g: 0, callsign });
      if (!mine(callsign)) continue;
      if (s.state === "failed") out.push({ kind: "fail", g: 1, callsign });
      const wait = (s.slot as { wait?: number | null } | null | undefined)?.wait;
      if (typeof wait === "number" && wait > 0) out.push({ kind: "wait", g: 1, callsign, at: wait * 1000 });
      // открыли карточку сессии — «готово» прочитано
      if (viewing(callsign)) done.delete(callsign);
      if (s.state === "idle" && done.has(callsign) && !seen.has(callsign)) out.push({ kind: "done", g: 2, callsign });
    }
    for (const [m, x] of gone) {
      if (x.list.length) out.push({ kind: "away", g: 1, machine: m, at: x.at, list: x.list.map((y) => y.callsign).join(", ") });
    }
    // ушли раньше, чем открыто приложение, — знает модуль точек (только пульт)
    const fire = app.mark("fire");
    if (typeof fire === "number" && fire > gone.size) out.push({ kind: "fire", g: 1, n: fire - gone.size });
    return out;
  }

  /** Заголовок карточки: лампа, позывной (открыть) и что случилось. */
  function CardHead({ s, dot, label }: { s: SessionRecord; dot: string; label: string }) {
    const name = app.use(() => app.mark("label.session", s.callsign)?.text ?? s.callsign);
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
    const name = app.use(() => app.mark("label.machine", machine)?.text ?? `@${machine}`);
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

  /** Карточка сессии: своя выборка записи, поэтому меняется только она. */
  const SessionCard = memo(function SessionCard({ kind, callsign, at }: { kind: Kind; callsign: string; at?: number }) {
    const s = app.use(() => app.roster()?.sessions.find((x) => x.callsign === callsign));
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
        const why = s.failed ? Object.values(s.failed as Record<string, string>).join("; ") : "";
        return (
          <div className="ib-it bad" data-kind="fail" data-callsign={callsign}>
            <CardHead s={s} dot="bad" label="не запустилась" />
            {why ? <div className="ib-tx">{why}</div> : null}
            <div className="ib-acts">
              <button
                className="pri"
                onClick={async () => {
                  const r = await app.request("session.start", { callsign });
                  if (!r.ok) app.toast(`${callsign} не запустилась: ${r.error}`);
                }}
              >
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
              <button
                className="ghost"
                onClick={() => {
                  seen.add(callsign);
                  app.changed();
                }}
              >
                Прочитано
              </button>
            </div>
          </div>
        );
    }
  });

  function Card({ it }: { it: Item }) {
    if (it.kind === "away") return <Away machine={it.machine!} at={it.at!} list={it.list!} />;
    if (it.kind === "fire") {
      return (
        <div className="ib-it bad" data-kind="fire">
          <div className="ib-ih">
            <Dot kind="gone" />
            <span className="ib-lb">{`машин не на связи: ${it.n}`}</span>
          </div>
          <div className="ib-acts">
            <button className="pri" onClick={() => app.open("points", {})}>
              Поднять из точки
            </button>
          </div>
        </div>
      );
    }
    return <SessionCard kind={it.kind} callsign={it.callsign!} at={it.at} />;
  }

  function Inbox() {
    const list = app.use(items);
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
        {([0, 1, 2] as const).map((g) => {
          const xs = list.filter((x) => x.g === g);
          if (!xs.length) return null;
          return [
            <div key={`g${g}`} className="ib-gh">
              {`${GROUPS[g]} · ${xs.length}`}
            </div>,
            ...xs.map((x) => <Card key={`${x.kind}:${x.callsign ?? x.machine ?? "fire"}`} it={x} />),
          ];
        })}
      </div>
    );
  }

  return {
    on: { roster: onRoster },
    screens: { inbox: { nav: "Вам", mark: "you", label: "Вам", path: "inbox", view: Inbox, head: () => ({ title: "Вам" }) } },
    marks: { you: () => items().length },
    css,
    start(a) {
      app = a;
    },
  };
}
