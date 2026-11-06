// Лента сессии. У пары — одна сцена: участники в шапке выбирают, кого показать; у каждой стороны своя строка и свой экран разговора с полем ввода.
// Участник — только он; он же ещё раз или стрелка — обе стороны. Адресат — поле в фокусе. На телефоне видна одна сторона. Выбор запоминается.
import type { MouseEvent, ReactNode } from "react";
import type { SessionRecord } from "@switchboard/web-core";
import { Dot, effortName, lamp, profileNameOf, sessionOf, slotOf, stateLabel, useApp, useModule, wingOf } from "@switchboard/web-ui";
import type { CardState, Shown } from "./module.tsx";

type Side = "lead" | "wing";

/** Что видно: на узком экране — одна сторона. */
function useShown(wide: boolean): Shown {
  const app = useApp();
  const card = useModule<CardState>();
  const shown = app.use(() => card.device.get().shown);
  return !wide && shown === "both" ? "lead" : shown;
}

/** Выбор в шапке: лампа и модель каждого участника, при равных моделях — слот; стрелка между ними — обе стороны. */
export function PairPick({ lead, wing }: { lead: SessionRecord; wing: SessionRecord }) {
  const app = useApp();
  const card = useModule<CardState>();
  const wide = app.wide;
  const view = useShown(wide);
  const item = (side: Side, s: SessionRecord) => (
    <button type="button" title={[profileNameOf(s), effortName(s.effort), slotOf(s)?.name].filter(Boolean).join(" · ")} aria-pressed={view === "both" || view === side} data-show={side} data-callsign={s.callsign} onClick={() => card.pick(side, wide)}>
      <Dot kind={lamp(s)} title={stateLabel(s.state).text} />
      <b>{String(s.model ?? "")}</b>
      {lead.model === wing.model ? <span>{slotOf(s)?.name ?? ""}</span> : null}
    </button>
  );
  return (
    <div className="cw-show" role="group" aria-label="Что показать">
      {item("lead", lead)}
      {wide ? (
        <button type="button" className="cw-arrow" aria-label="Обе стороны" aria-pressed={view === "both"} data-show="both" onClick={() => card.pick("both", wide)}>
          ▸
        </button>
      ) : (
        <i aria-hidden="true">▸</i>
      )}
      {item("wing", wing)}
    </div>
  );
}

/** Участник одной строкой: модель, слот и живая строка шага; остальное — в подсказке и на вкладке «Сведения». open — скрытая сторона: нажатие показывает её. */
function Who({ s, open, live }: { s: SessionRecord; open?(): void; live: boolean }) {
  const app = useApp();
  const slot = slotOf(s)?.name ?? "";
  const account = String(s.account ?? "");
  const facts = [profileNameOf(s), effortName(s.effort), slot, account === slot ? "" : account].filter(Boolean).join(" · ");
  const body = (
    <>
      <Dot kind={lamp(s)} title={stateLabel(s.state).text} />
      <b>{String(s.model ?? "")}</b>
      <span className="cw-facts" title={facts}>
        {slot}
      </span>
      {live ? (
        <span className="cw-step">
          <app.Slot screen="chat" params={{ callsign: s.callsign, part: "last" }} />
        </span>
      ) : null}
    </>
  );
  return open ? (
    <button type="button" className="cw-who" data-callsign={s.callsign} onClick={open}>
      {body}
    </button>
  ) : (
    <div className="cw-who" data-callsign={s.callsign}>
      {body}
    </div>
  );
}

/** Вкладка по участникам: у пары — колонка на каждого, у обычной сессии — как есть. */
export function Lanes({ callsign, each }: { callsign: string; each(cs: string): ReactNode }) {
  const app = useApp();
  const lead = app.use(() => sessionOf(app, callsign));
  const wing = app.use(() => wingOf(app.roster()?.sessions ?? [], callsign));
  if (!lead || !wing) return <>{each(callsign)}</>;
  return (
    <div className="cw-lanes">
      {[lead, wing].map((s) => (
        <div key={s.callsign} className="cw-lane" data-lane={s.callsign}>
          <Who s={s} live={false} />
          {each(s.callsign)}
        </div>
      ))}
    </div>
  );
}

export function Feeds({ callsign, wide }: { callsign: string; wide: boolean }) {
  const app = useApp();
  const card = useModule<CardState>();
  const lead = app.use(() => sessionOf(app, callsign));
  const wing = app.use(() => wingOf(app.roster()?.sessions ?? [], callsign));
  const view = useShown(wide);
  if (!lead || !wing) return <app.Slot screen="chat" params={{ callsign }} />;
  const rec = { lead, wing };
  const both = view === "both";
  const sides: Side[] = both ? ["lead", "wing"] : [view];
  const other: Side = view === "lead" ? "wing" : "lead";
  /** Нажатие в ленту ставит курсор в её поле, если человек не выделял текст и не нажал на элемент ленты. */
  const press = (e: MouseEvent<HTMLElement>) => {
    if (!wide || (e.target as Element).closest("button,a,input,textarea,select,summary") || !document.getSelection()?.isCollapsed) return;
    e.currentTarget.querySelector("textarea")?.focus();
  };
  return (
    <div className={wide ? "cw-stage" : "cw-stage narrow"}>
      {both ? null : (
        <div className="cw-whos">
          <Who s={rec[view as Side]} live={false} />
          <Who s={rec[other]} live open={() => card.pick(other, wide)} />
        </div>
      )}
      <div className="cw-lanes">
        {sides.map((side) => (
          <div key={side} className="cw-lane" data-feed={side} onClick={press}>
            {both ? <Who s={rec[side]} live /> : null}
            <app.Slot screen="chat" params={{ callsign: rec[side].callsign }} />
          </div>
        ))}
      </div>
    </div>
  );
}
