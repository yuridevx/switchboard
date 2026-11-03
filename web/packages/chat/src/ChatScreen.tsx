// Экран чата: полоса над лентой, лента и всё, что над вводом и под ней.
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, Download, Focus, Gauge } from "lucide-react";
import { machineOf } from "@switchboard/protocol";
import { Pad } from "@switchboard/web-ui";
import { RowView } from "./cards/ItemView.tsx";
import { Composer } from "./composer/Composer.tsx";
import { CardsCtx, useChat, type CardsView } from "./context.ts";
import { AskDock, BackgroundDock, TodoDock } from "./docks/Docks.tsx";
import { ContextPanel } from "./panel/ContextPanel.tsx";
import { focusRows, type Row } from "./state/focus.ts";
import type { Feed } from "./state/types.ts";
import { useStickToBottom } from "./ui/useStickToBottom.ts";

/** Плашка отката под сообщением. */
function RewindCard({ callsign, id }: { callsign: string; id: string }) {
  const chat = useChat();
  const r = chat.useConv(callsign, (c) => (c.rewind?.uuid === id ? c.rewind : null));
  if (!r) return null;
  return (
    <div className={`chat-rwc ${r.tone}`} role="status">
      <span>{r.text}</span>
      {r.ready ? (
        <>
          <button type="button" className="chat-mini" onClick={() => chat.cancelRewind(callsign)}>
            Отмена
          </button>
          <button type="button" className="chat-mini bad" onClick={() => void chat.applyRewind(callsign, r.uuid)}>
            Откатить
          </button>
        </>
      ) : null}
    </div>
  );
}

/** Строка ленты: новое сообщение не перерисовывает остальные. */
const FeedRow = memo(function FeedRow({ row, callsign }: { row: Row; callsign: string }) {
  return (
    <>
      <RowView row={row} />
      <RewindCard callsign={callsign} id={row.id} />
    </>
  );
});

/** Внизу ленты: идёт сжатие или ход. */
function Working({ callsign }: { callsign: string }) {
  const chat = useChat();
  const compacting = chat.useConv(callsign, (c) => c.feed.compacting);
  const thinking = chat.useConv(callsign, (c) => c.feed.thinking);
  const busy = chat.useApp(() => chat.sessionOf(callsign)?.state === "busy");
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
  const chat = useChat();
  const items = chat.useConv(callsign, (c) => c.feed.items);
  const tools = chat.useConv(callsign, (c) => c.feed.tools);
  const focus = chat.useConv(callsign, (c) => c.focus);
  const noFeed = chat.useConv(callsign, (c) => c.noFeed);
  const refused = chat.useConv(callsign, (c) => c.refused);
  const more = chat.useConv(callsign, (c) => c.more);
  const rows = useMemo<Row[]>(() => (chat.wide && focus ? focusRows(items, tools) : items.map((item) => ({ id: item.id, item }))), [chat.wide, focus, items, tools]);
  const box = useRef<HTMLDivElement>(null);
  const col = useRef<HTMLDivElement>(null);
  const { away, toBottom } = useStickToBottom(box, col);
  return (
    <div className="chat-feedw">
      <Pad ref={box} className="chat-feed" aria-live="polite">
        <div ref={col} className="chat-col">
          {noFeed ? <div className="chat-note">{`${machineOf(callsign)} не отдаёт ленту — только переписка и ввод`}</div> : null}
          {more ? (
            <button type="button" className="chat-older" onClick={() => void chat.older(callsign)}>
              Раньше
            </button>
          ) : null}
          {rows.map((row) => (
            <FeedRow key={row.id} row={row} callsign={callsign} />
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
  const chat = useChat();
  const focus = chat.useConv(callsign, (c) => c.focus);
  const canCall = chat.useApp(() => chat.can(callsign, "session.call") && chat.isLive(callsign));
  return (
    <div className="chat-bar">
      {canCall ? (
        <button type="button" className="chat-mini" aria-pressed={panel} onClick={() => setPanel(!panel)}>
          <Gauge size={13} />
          контекст
        </button>
      ) : null}
      <button type="button" className="chat-mini" aria-pressed={focus} onClick={() => chat.toggleFocus(callsign)}>
        <Focus size={13} />
        фокус
      </button>
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

export function ChatScreen({ callsign }: { callsign: string }) {
  const chat = useChat();
  const [panel, setPanel] = useState(false);
  useEffect(() => chat.mount(callsign), [chat, callsign]);
  const name = chat.useApp(() => chat.nameOf(callsign));
  const canCall = chat.useApp(() => chat.isLive(callsign) && chat.can(callsign, "session.call"));
  // что карточкам ленты: выборка из этого разговора и кнопки, если сессия жива и машина умеет session.call
  const view = useMemo<CardsView>(
    () => ({
      useFeed: <T,>(select: (f: Feed) => T) => chat.useConv(callsign, (c) => select(c.feed)),
      name,
      wide: chat.wide,
      background: canCall ? (id) => void chat.call(callsign, "backgroundTasks", [id]) : undefined,
      stopTask: canCall ? (id) => void chat.call(callsign, "stopTask", [id]) : undefined,
      rewind: chat.wide && canCall ? (id) => void chat.probeRewind(callsign, id) : undefined,
      resend: (id, text) => chat.resend(callsign, id, text),
      edit: (text) => chat.returnText(callsign, text),
    }),
    [chat, callsign, name, canCall],
  );
  return (
    <CardsCtx.Provider value={view}>
      <div className={chat.wide ? "chat wide" : "chat"}>
        {chat.wide ? <Bar callsign={callsign} panel={panel} setPanel={setPanel} /> : null}
        {panel ? <ContextPanel callsign={callsign} close={() => setPanel(false)} /> : null}
        <FeedView callsign={callsign} />
        <div className="chat-dock">
          <BackgroundDock callsign={callsign} />
          <TodoDock callsign={callsign} />
          <AskDock callsign={callsign} />
        </div>
        <Composer key={callsign} callsign={callsign} />
      </div>
    </CardsCtx.Provider>
  );
}
