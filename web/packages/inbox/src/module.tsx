// «Вам»: что ждёт человека. Карточки — функция от roster и меток; своё — только кто закончил ход и какие мои сессии были на машине.
import type { ReactNode } from "react";
import { machineOf } from "@switchboard/protocol";
import type { AppPart, ScreenProps } from "@switchboard/web-core";
import { at, Btn, Dot, failText, isLive, lamp, machineLabel, sessionLabel, slotOf, TextBtn, useApp, type App } from "@switchboard/web-ui";
import css from "./inbox.css";

type Kind = "q" | "msg" | "fail" | "wait" | "away" | "fire" | "done";
type Card = { kind: Kind; callsign?: string; machine?: string; dot: string; label: string; text?: string };

const GROUPS: Array<[string, Kind[]]> = [["Ждут ответа", ["q", "msg"]], ["Сломалось или ждёт", ["fail", "wait", "away", "fire"]], ["Готово", ["done"]]];
const TONE: Record<Kind, string> = { q: "you", msg: "you", fail: "bad", wait: "bad", away: "bad", fire: "bad", done: "done" };
/** Закончила ход: из этих состояний в свободную. После ответа на вопрос сессия просто продолжает разговор. */
const WORKED = ["busy", "starting"];

export const createInbox = ((app) => {
  const states = new Map<string, unknown>();
  const finished = new Set<string>();
  /** мои сессии машины, какими их видели на связи: ушедшая их уже не покажет */
  const seen = new Map<string, string[]>();
  const mine = (callsign: string) => !!app.mark("mine", callsign);
  const opened = () => app.current()?.params.callsign;

  function onRoster(r: NonNullable<ReturnType<App["roster"]>>) {
    for (const s of r.sessions) {
      if (s.state !== "idle") finished.delete(s.callsign);
      else if (WORKED.includes(states.get(s.callsign) as string) && opened() !== s.callsign) finished.add(s.callsign);
      states.set(s.callsign, s.state);
    }
  }

  const project = (callsign: string, label: string) => {
    const p = app.mark("project.of", callsign) as { name: string } | null | undefined;
    return p ? `${label} · ${p.name}` : label;
  };

  function cards(): Card[] {
    const sessions = app.roster()?.sessions ?? [];
    for (const m of app.roster()?.machines ?? []) seen.set(m.machine, sessions.map((s) => s.callsign).filter((c) => machineOf(c) === m.machine && mine(c)));
    const gone = (app.mark("machines.gone") ?? {}) as Readonly<Record<string, number>>;
    const fire = ((app.mark("fire") ?? []) as string[]).filter((m) => !Object.hasOwn(gone, m));
    return [
      ...sessions.flatMap((s): Card[] => {
        const { callsign } = s;
        const unread = app.mark("unread", callsign) as { count: number; text: string } | undefined;
        if (app.mark("asked", callsign)) return [{ kind: "q", callsign, dot: "wait", label: project(callsign, "спрашивает") }];
        return unread?.count ? [{ kind: "msg", callsign, dot: "wait", label: project(callsign, "пишет вам"), text: unread.text }] : [];
      }),
      ...sessions.flatMap((s): Card[] => {
        const { callsign } = s;
        const wait = slotOf(s)?.wait;
        if (!mine(callsign)) return [];
        if (s.state === "failed") return [{ kind: "fail", callsign, dot: "bad", label: project(callsign, "не запустилась"), text: failText(s) }];
        return wait ? [{ kind: "wait", callsign, dot: "idle", label: project(callsign, "ждёт сброса лимита"), text: `Аккаунты слота ${slotOf(s)!.name} у порога — продолжит после ${at(wait)}` }] : [];
      }),
      ...Object.entries(gone).flatMap(([machine, t]): Card[] => {
        const here = seen.get(machine) ?? [];
        return here.length ? [{ kind: "away", machine, dot: "gone", label: `не на связи с ${at(t)}`, text: here.join(", ") }] : [];
      }),
      ...(fire.length ? [{ kind: "fire" as const, dot: "gone", label: `машин не на связи: ${fire.length}` }] : []),
      ...sessions.flatMap((s): Card[] => (finished.has(s.callsign) && mine(s.callsign) && isLive(s.state) ? [{ kind: "done", callsign: s.callsign, dot: lamp(s), label: project(s.callsign, "готово") }] : [])),
    ];
  }

  async function restart(callsign: string) {
    const r = await app.request("session.start", { callsign });
    if (!r.ok) app.toast(`${callsign} не запустилась: ${r.error}`);
  }
  function read(callsign: string) {
    finished.delete(callsign);
    app.changed();
  }

  function actions(c: Card, open: (params?: Record<string, string>) => void): ReactNode {
    const up = (
      <Btn pri onClick={() => app.open("points")}>
        Поднять из точки
      </Btn>
    );
    if (c.kind === "away" || c.kind === "fire") return up;
    if (c.kind === "msg") return <Btn pri onClick={() => open()}>Открыть</Btn>;
    if (c.kind === "wait") return <Btn onClick={() => open()}>Открыть</Btn>;
    if (c.kind === "done") {
      return (
        <>
          <Btn pri onClick={() => open()}>
            Открыть
          </Btn>
          <Btn ghost onClick={() => read(c.callsign!)}>
            Прочитано
          </Btn>
        </>
      );
    }
    if (c.kind !== "fail") return null;
    return (
      <>
        <Btn pri onClick={() => void restart(c.callsign!)}>
          Запустить снова
        </Btn>
        <Btn onClick={() => open(app.wide ? {} : { tab: "info" })}>Почему</Btn>
      </>
    );
  }

  function Item({ card }: { card: Card }) {
    const shell = useApp();
    const { callsign, machine } = card;
    const open = (params: Record<string, string> = {}) => shell.open("card", { callsign: callsign!, ...params });
    const name = shell.use(() => (callsign ? sessionLabel(shell, callsign).text : machine ? machineLabel(shell, machine).text : ""));
    const buttons = actions(card, open);
    return (
      <div className={`ib-it ${TONE[card.kind]}`} data-kind={card.kind} data-callsign={callsign} data-machine={machine}>
        <div className="ib-ih">
          <Dot kind={card.dot} />
          {callsign ? (
            <TextBtn className="ib-cs" onClick={() => open()}>
              {name}
            </TextBtn>
          ) : (
            name && <b className="ib-cs">{name}</b>
          )}
          <span className="ib-lb">{card.label}</span>
        </div>
        {card.text && <div className="ib-tx">{card.text}</div>}
        {card.kind === "q" && (
          <div className="ib-q">
            <shell.Slot screen="ask" params={{ callsign: callsign! }} />
          </div>
        )}
        {buttons && <div className="ib-acts">{buttons}</div>}
      </div>
    );
  }

  function Screen(_: ScreenProps) {
    const list = app.use(cards);
    return (
      <div className={app.wide ? "ib wide" : "ib"}>
        {GROUPS.map(([title, kinds]) => {
          const here = list.filter((c) => kinds.includes(c.kind));
          if (!here.length) return null;
          return [
            <div key={title} className="ib-gh">{`${title} · ${here.length}`}</div>,
            ...here.map((c) => <Item key={`${c.kind}:${c.callsign ?? c.machine ?? ""}`} card={c} />),
          ];
        })}
        {!list.length && (
          <div className="ib-empty">
            <b>Всё разобрано</b>
          </div>
        )}
      </div>
    );
  }

  return {
    css,
    on: {
      roster: onRoster,
      current: (c) => void (c.params.callsign && finished.delete(c.params.callsign)),
    },
    marks: { you: () => cards().length },
    screens: { inbox: { nav: "Вам", mark: "you", label: "Вам", view: Screen, head: () => ({ title: "Вам" }) } },
  };
}) satisfies AppPart["module"];
