// Экран «Вам»: карточки по группам; пусто — «Всё разобрано».
import { Fragment } from "react";
import { useApp } from "@switchboard/web-core";
import { useInbox } from "./context.ts";
import { InboxCard } from "./InboxCards.tsx";

const GROUPS = ["Ждут ответа", "Сломалось или ждёт", "Готово"];

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
              <InboxCard key={`${x.kind}:${x.callsign ?? x.machine ?? "fire"}`} it={x} />
            ))}
          </Fragment>
        );
      })}
    </div>
  );
}
