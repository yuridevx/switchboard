// Экран «Вам»: карточки группами. Действие карточки — по её виду.
import { Btn, Dot, TextBtn, useApp, useModule } from "@switchboard/web-ui";
import type { Card, InboxState } from "./module.tsx";

const GROUPS: Array<[string, Array<Card["kind"]>]> = [["Ждут ответа", ["q", "msg"]], ["Сломалось или ждёт", ["fail", "wait", "away", "fire"]], ["Готово", ["done"]]];
const TONE: Record<Card["kind"], string> = { q: "you", msg: "you", fail: "bad", wait: "bad", away: "bad", fire: "bad", done: "done" };

function Item({ card }: { card: Card }) {
  const app = useApp();
  const inbox = useModule<InboxState>();
  const cs = card.callsign ?? "";
  const open = (params: Record<string, string> = {}) => app.open("card", { callsign: cs, ...params });
  async function restart() {
    const r = await app.request("session.start", { callsign: cs });
    if (!r.ok) app.toast(`${cs} не запустилась: ${r.error}`);
  }
  const canPoints = app.use(() => !!app.mark("fire"));
  return (
    <div className={`ib-it ${TONE[card.kind]}`} data-kind={card.kind} data-callsign={card.callsign} data-machine={card.machine}>
      <div className="ib-ih">
        <Dot kind={card.dot} />
        {card.callsign ? (
          <TextBtn className="ib-cs" onClick={() => open()}>
            {card.name}
          </TextBtn>
        ) : card.name ? (
          <b className="ib-cs">{card.name}</b>
        ) : null}
        {card.label ? <span className="ib-lb">{card.label}</span> : null}
      </div>
      {card.text ? <div className="ib-tx">{card.text}</div> : null}
      {card.kind === "q" ? (
        <div className="ib-q">
          <app.Slot screen="ask" params={{ callsign: cs }} />
        </div>
      ) : (
        <div className="ib-acts">
          {card.kind === "msg" ? (
            <Btn pri onClick={() => open()}>
              Открыть
            </Btn>
          ) : null}
          {card.kind === "fail" ? (
            <>
              <Btn pri onClick={() => void restart()}>
                Запустить снова
              </Btn>
              <Btn onClick={() => open(app.wide ? {} : { tab: "info" })}>Почему</Btn>
            </>
          ) : null}
          {card.kind === "wait" ? <Btn onClick={() => open()}>Открыть</Btn> : null}
          {(card.kind === "away" || card.kind === "fire") && canPoints ? (
            <Btn pri onClick={() => app.open("points")}>
              Поднять из точки
            </Btn>
          ) : null}
          {card.kind === "done" ? (
            <>
              <Btn onClick={() => open()}>Открыть</Btn>
              <Btn ghost onClick={() => inbox.clearDone(cs)}>
                Прочитано
              </Btn>
            </>
          ) : null}
        </div>
      )}
    </div>
  );
}

export function InboxScreen() {
  const app = useApp();
  const inbox = useModule<InboxState>();
  const cards = app.use(() => inbox.cards());
  return (
    <div className={app.wide ? "ib wide" : "ib"}>
      {GROUPS.map(([title, kinds]) => {
        const list = cards.filter((c) => kinds.includes(c.kind));
        if (!list.length) return null;
        return [
          <div key={title} className="ib-gh">{`${title} · ${list.length}`}</div>,
          ...list.map((c) => <Item key={`${c.kind}:${c.callsign ?? c.machine ?? ""}`} card={c} />),
        ];
      })}
      {cards.length ? null : (
        <div className="ib-empty">
          <b>Всё разобрано</b>
        </div>
      )}
    </div>
  );
}
