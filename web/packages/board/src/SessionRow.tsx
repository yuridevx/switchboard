// Строка сессии: читает только своё; на изменение одной сессии перерисовывается она одна.
import { memo } from "react";
import { Badge, Dot, RowBtn } from "@switchboard/web-ui";
import { useBoard } from "./store.ts";
import type { RowItem } from "./model.ts";
import { useHeld } from "./useHeld.ts";

export const SessionRow = memo(function SessionRow({ callsign, depth, noAt, project }: Omit<RowItem, "k">) {
  const board = useBoard();
  const d = useHeld(() => board.rowData(callsign, noAt, project));
  if (!d) return null;
  return (
    <RowBtn
      className={"bd-row" + (depth ? " kid" : "")}
      data-callsign={callsign}
      aria-current={d.current ? "true" : "false"}
      style={depth ? { paddingLeft: `${10 + depth * 22}px` } : undefined}
      onClick={() => {
        const s = board.session(callsign);
        if (s) board.openSession(s);
      }}
    >
      {d.lamp ? <Dot kind={d.lamp} title={d.title} /> : null}
      <span className="bd-rt">
        <span className="bd-t1">
          <b className={"bd-cs" + (d.human ? " hum" : "")}>{d.name}</b>
          {d.owner ? <span className="bd-pill own">{d.owner}</span> : null}
          {d.inc ? <span className="bd-pill inc">{d.inc}</span> : null}
          {d.pin ? (
            <svg className="bd-pin" viewBox="0 0 16 16" role="img" aria-label="закреплена">
              <path d="M6 2h4l-.5 4 2.5 2.5V10H8.6L8 14l-.6-4H4V8.5L6.5 6z" />
            </svg>
          ) : null}
          {d.at !== null ? <span className={"bd-at" + (d.atHuman ? " hum" : "")}>{d.at}</span> : null}
        </span>
        {d.t2.length ? (
          <span className="bd-t2">
            {d.t2.map((x) => (
              <span key={x.c} className={x.c}>
                {x.t}
              </span>
            ))}
          </span>
        ) : null}
      </span>
      {d.badge === "?" ? (
        <Badge wait aria-label="ждёт ответа">
          ?
        </Badge>
      ) : d.badge ? (
        <Badge>{d.badge}</Badge>
      ) : null}
    </RowBtn>
  );
});
