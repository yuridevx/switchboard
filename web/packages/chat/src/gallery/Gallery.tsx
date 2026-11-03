// Галерея карточек: каждый образец свёрнут той же лентой и нарисован теми же компонентами; соединения нет, кнопки ничего не шлют.
import { useMemo } from "react";
import { Pad } from "@switchboard/web-ui";
import { ItemView } from "../cards/ItemView.tsx";
import { CardsCtx, type CardsView } from "../context.ts";
import { applyEvents, emptyFeed } from "../state/feed.ts";
import type { Feed } from "../state/types.ts";
import { SECTIONS, type Sample } from "./samples.ts";

const noop = () => {};

function SampleRow({ s }: { s: Sample }) {
  const feed = useMemo(() => applyEvents(emptyFeed(), s.msgs), [s]);
  const view = useMemo<CardsView>(() => ({ useFeed: <T,>(select: (f: Feed) => T) => select(feed), name: "site@laptop", wide: true, background: noop, stopTask: noop, rewind: noop, resend: noop, edit: noop }), [feed]);
  return (
    <div className="chat-galr" data-sample={s.title}>
      <div className="chat-galn">{s.title}</div>
      <div className="chat-galc">
        <CardsCtx.Provider value={view}>
          {feed.items.map((it) => (
            <ItemView key={it.id} it={it} />
          ))}
        </CardsCtx.Provider>
      </div>
    </div>
  );
}

export function Gallery() {
  return (
    <Pad className="chat-gal">
      {SECTIONS.map((sec) => (
        <section key={sec.title} className="chat-gals">
          <h3>{sec.title}</h3>
          {sec.samples.map((s) => (
            <SampleRow key={s.title} s={s} />
          ))}
        </section>
      ))}
    </Pad>
  );
}
