// Галерея карточек: каждый образец свёрнут той же лентой и нарисован теми же компонентами; соединения нет, кнопки ничего не шлют.
import { useMemo, type ReactNode } from "react";
import { Pad } from "@switchboard/web-ui";
import { ItemView } from "../cards/ItemView.tsx";
import { MeCard } from "../cards/UserCards.tsx";
import { OutputView, SideCard } from "../docks/Docks.tsx";
import { CardsCtx, type CardsView } from "../context.ts";
import { applyEvents, emptyFeed } from "../state/feed.ts";
import type { Feed } from "../state/types.ts";
import { SECTIONS, type Sample } from "./samples.ts";

const noop = () => {};

function SampleRow({ s }: { s: Sample }) {
  const feed = useMemo(() => applyEvents(emptyFeed(), s.msgs), [s]);
  const view = useMemo<CardsView>(() => ({ useFeed: <T,>(select: (f: Feed) => T) => select(feed), useAsking: (id) => !!s.asking?.includes(id), name: "site@laptop", wide: true, background: noop, stopTask: noop, rewind: noop, resend: noop, edit: noop }), [feed]);
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

const noop2 = () => {};
const OWN: CardsView = { useFeed: <T,>(select: (f: Feed) => T) => select(emptyFeed()), useAsking: () => false, name: "site@laptop", wide: true, background: noop2, stopTask: noop2, rewind: noop2, resend: noop2, unqueue: noop2, edit: noop2 };

/** Состояния вне свёртки SDK: они зависят от ответа запроса, а не от сообщения. */
function OwnStates() {
  const at = 1_793_700_000_000;
  const row = (title: string, node: ReactNode) => (
    <div className="chat-galr" data-sample={title}>
      <div className="chat-galn">{title}</div>
      <div className="chat-galc">{node}</div>
    </div>
  );
  return (
    <section className="chat-gals">
      <h3>Над вводом и своё</h3>
      <CardsCtx.Provider value={OWN}>
        {row("Сообщение в очереди", <MeCard it={{ kind: "user", id: "q1", text: "И обнови README по итогам", images: [], files: [], at, state: "ok", queued: true }} />)}
        {row("Отправляется", <MeCard it={{ kind: "user", id: "q2", text: "Задеплой на стенд", images: [], files: [], at, state: "sending" }} />)}
        {row("Доставлено", <MeCard it={{ kind: "user", id: "q3", text: "Задеплой на стенд", images: [], files: [], at, state: "echo" }} />)}
        {row("Связь оборвалась", <MeCard it={{ kind: "user", id: "q4", text: "Задеплой на стенд", images: [], files: ["report.txt"], at, state: "lost" }} />)}
        {row("Вопрос сбоку: думает", <SideCard s={{ id: "s1", q: "какая версия на тесте?" }} drop={noop2} />)}
        {row("Вопрос сбоку: ответ", <SideCard s={{ id: "s2", q: "какая версия на тесте?", a: "На тесте **2.0.0+5**, на проде 2.0.0+3." }} drop={noop2} />)}
        {row("Вопрос сбоку: отказ", <SideCard s={{ id: "s3", q: "какая версия на тесте?", err: "Claude отказал, причина в журнале машины" }} drop={noop2} />)}
        {row("Вывод задачи", <OutputView data={{ output: "VITE ready in 412 ms\n  Local: http://localhost:5173/", total_bytes: 512, truncated: false }} />)}
        {row("Вывод задачи: длинный", <OutputView data={{ output: "… 4187 passed\nTests 215 passed", total_bytes: 20480, truncated: true }} />)}
        {row("Вывод задачи: пока пусто", <OutputView data={{ output: "", total_bytes: 0, truncated: false }} />)}
        {row("Вывод задачи: отказ", <OutputView error="wsl не на связи" />)}
      </CardsCtx.Provider>
    </section>
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
      <OwnStates />
    </Pad>
  );
}
