// Экран чата: полоса над лентой, лента и всё, что над вводом и под ней.
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, Download, Focus, Gauge } from "lucide-react";
import type { ScreenProps } from "@switchboard/web-core";
import { machineOf } from "@switchboard/protocol";
import { Pad, useApp, Btn } from "@switchboard/web-ui";
import { ItemView, StepsRow } from "./cards/ItemView.tsx";
import { Composer } from "./composer/Composer.tsx";
import { CardsCtx, useChat, type CardsView, useConv } from "./context.ts";
import { AskDock, BackgroundDock, SideDock, TodoDock } from "./docks/Docks.tsx";
import { ContextPanel } from "./panel/ContextPanel.tsx";
import { focusRows, type Row, type Steps } from "./state/focus.ts";
import type { Item } from "./state/types.ts";
import { useStickToBottom } from "./ui/useStickToBottom.ts";

/** Плашка отката под сообщением. */
function RewindCard({ callsign, id }: { callsign: string; id: string }) {
  const chat = useChat();
  const r = useConv(callsign, (c) => (c.rewind?.uuid === id ? c.rewind : null));
  if (!r) return null;
  return (
    <div className={`chat-rwc ${r.tone}`} role="status">
      <span>{r.text}</span>
      {r.ready ? (
        <>
          <Btn type="button" className="chat-mini" onClick={() => chat.cancelRewind(callsign)}>
            Отмена
          </Btn>
          <Btn bad type="button" className="chat-mini" onClick={() => void chat.applyRewind(callsign, r.uuid)}>
            Откатить
          </Btn>
        </>
      ) : null}
    </div>
  );
}

/** Строка ленты: новое сообщение не перерисовывает остальные. */
const FeedRow = memo(function FeedRow({ id, item, steps, callsign }: { id: string; item?: Item; steps?: Steps; callsign: string }) {
  return (
    <>
      {item ? <ItemView it={item} /> : <StepsRow steps={steps!} />}
      <RewindCard callsign={callsign} id={id} />
    </>
  );
});

/** Внизу ленты: идёт сжатие или ход. */
function Working({ callsign }: { callsign: string }) {
  const app = useApp();
  const chat = useChat();
  const compacting = useConv(callsign, (c) => c.feed.compacting);
  const thinking = useConv(callsign, (c) => c.feed.thinking);
  const busy = app.use(() => chat.sessionOf(callsign)?.state === "busy");
  if (compacting) return <div className="chat-work">Сжимаю контекст…</div>;
  if (!busy) return null;
  return (
    <div className="chat-work">
      <i />
      <i />
      <i />
      {thinking ? `размышляет · ${Math.round(thinking / 100) / 10} К` : null}
    </div>
  );
}

function FeedView({ callsign }: { callsign: string }) {
  const app = useApp();
  const chat = useChat();
  const items = useConv(callsign, (c) => c.feed.items);
  const tools = useConv(callsign, (c) => c.feed.tools);
  const focus = useConv(callsign, (c) => c.focus);
  const noFeed = useConv(callsign, (c) => c.noFeed);
  const refused = useConv(callsign, (c) => c.refused);
  const more = useConv(callsign, (c) => c.more);
  const rows = useMemo<Row[]>(() => (app.wide && focus ? focusRows(items, tools) : items.map((item) => ({ id: item.id, item }))), [app.wide, focus, items, tools]);
  const box = useRef<HTMLDivElement>(null);
  const col = useRef<HTMLDivElement>(null);
  const { away, toBottom } = useStickToBottom(box, col);
  return (
    <div className="chat-feedw">
      <Pad ref={box} className="chat-feed" aria-live="polite">
        <div ref={col} className="chat-col">
          {noFeed ? <div className="chat-note">{`${machineOf(callsign)} не отдаёт ленту — только переписка и ввод`}</div> : null}
          {more ? (
            <Btn type="button" className="chat-older" onClick={() => void chat.older(callsign)}>
              Раньше
            </Btn>
          ) : null}
          {rows.map((row) => (
            <FeedRow key={row.id} id={row.id} item={"item" in row ? row.item : undefined} steps={"steps" in row ? row.steps : undefined} callsign={callsign} />
          ))}
          {refused ? (
            <div className="chat-note" role="alert">
              {refused}
            </div>
          ) : !rows.length && !noFeed ? (
            <div className="chat-note">Сообщений пока нет</div>
          ) : null}
          <Working callsign={callsign} />
        </div>
      </Pad>
      {away ? (
        <button type="button" className="chat-jump" aria-label="К последнему" onClick={toBottom}>
          <ArrowDown size={16} />
        </button>
      ) : null}
    </div>
  );
}

/** Полоса над лентой: контекст, фокус, выгрузка. Чего нет в contract машины — того нет. */
function Bar({ callsign, panel, setPanel }: { callsign: string; panel: boolean; setPanel(v: boolean): void }) {
  const app = useApp();
  const chat = useChat();
  const focus = useConv(callsign, (c) => c.focus);
  const canCall = app.use(() => chat.canCall(callsign));
  return (
    <div className="chat-bar">
      {canCall ? (
        <Btn type="button" className="chat-mini" aria-pressed={panel} onClick={() => setPanel(!panel)}>
          <Gauge size={13} />
          контекст
        </Btn>
      ) : null}
      <Btn type="button" className="chat-mini" aria-pressed={focus} onClick={() => chat.toggleFocus(callsign)}>
        <Focus size={13} />
        фокус
      </Btn>
      <a
        className="chat-mini"
        download={`${callsign.replace("@", "-")}.md`}
        href="#"
        onClick={(e) => {
          e.currentTarget.href = `data:text/markdown;charset=utf-8,${encodeURIComponent(chat.exportMd(callsign))}`;
        }}
      >
        <Download size={13} />
        выгрузить .md
      </a>
    </div>
  );
}

export function ChatScreen({ params }: ScreenProps) {
  const callsign = params.callsign ?? "";
  const app = useApp();
  const chat = useChat();
  const [panel, setPanel] = useState(false);
  useEffect(() => chat.mount(callsign), [chat, callsign]);
  const name = app.use(() => chat.nameOf(callsign));
  const canCall = app.use(() => chat.canCall(callsign));
  // что карточкам ленты: выборка из этого разговора и кнопки, если сессия жива и машина умеет session.call
  const view = useMemo<CardsView>(
    () => ({
      feed: () => chat.conv(callsign).feed,
      asking: (id) => !!app.mark("asked.tool", callsign, id),
      name,
      wide: app.wide,
      background: canCall ? (id) => void chat.call(callsign, "backgroundTasks", [id]) : undefined,
      stopTask: canCall ? (id) => void chat.call(callsign, "stopTask", [id]) : undefined,
      rewind: app.wide && canCall ? (id) => void chat.probeRewind(callsign, id) : undefined,
      resend: (id, text) => chat.resend(callsign, id, text),
      unqueue: canCall ? (id, text) => void chat.unqueue(callsign, id, text) : undefined,
      edit: (text) => chat.returnText(callsign, text),
    }),
    [app.wide, chat, callsign, name, canCall],
  );
  return (
    <CardsCtx.Provider value={view}>
      <div className={app.wide ? "chat wide" : "chat"}>
        {app.wide ? <Bar callsign={callsign} panel={panel} setPanel={setPanel} /> : null}
        {panel ? <ContextPanel callsign={callsign} close={() => setPanel(false)} /> : null}
        <FeedView callsign={callsign} />
        <div className="chat-dock">
          <SideDock callsign={callsign} />
          <BackgroundDock callsign={callsign} />
          <TodoDock callsign={callsign} />
          <AskDock callsign={callsign} />
        </div>
        <Composer callsign={callsign} />
      </div>
    </CardsCtx.Provider>
  );
}
