// Экран chat: лента, полоса над ней, док и ввод.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, Download, Focus, Gauge } from "lucide-react";
import type { ScreenProps } from "@switchboard/web-core";
import { machineOf } from "@switchboard/protocol";
import { Pad, sessionOf, useApp, useModule } from "@switchboard/web-ui";
import { exportMd } from "../export.ts";
import { focused } from "../focus.ts";
import type { Chats } from "../store.ts";
import { Composer } from "./Composer.tsx";
import { Dock } from "./Dock.tsx";
import { Panel } from "./Panel.tsx";
import { EnvCtx, Rows } from "./Rows.tsx";

/** Ближе этого к низу лента считается у края и идёт за новыми строками. */
const AT_END_PX = 48;

const tokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)} К` : String(n));

function Work({ callsign }: { callsign: string }) {
  const app = useApp();
  const chats = useModule<Chats>();
  const busy = app.use(() => sessionOf(app, callsign)?.state === "busy");
  const compacting = app.use(() => chats.conv(callsign).view.compacting);
  const thinking = app.use(() => chats.conv(callsign).view.thinking);
  if (!busy && !compacting && !thinking) return null;
  return (
    <div className="chat-work">
      <i />
      <i />
      <i />
      {compacting ? "Сжимаю контекст…" : thinking ? `размышляет · ${tokens(thinking)}` : ""}
    </div>
  );
}

function Bar({ callsign }: { callsign: string }) {
  const app = useApp();
  const chats = useModule<Chats>();
  const canAct = app.use(() => chats.canAct(callsign));
  const focus = app.use(() => chats.conv(callsign).focus);
  const [panel, setPanel] = useState(false);
  return (
    <>
      <div className="chat-bar">
        {canAct ? (
          <button type="button" className="chat-mini" aria-pressed={panel} onClick={() => setPanel(!panel)}>
            <Gauge size={12} />
            контекст
          </button>
        ) : null}
        <button type="button" className="chat-mini" aria-pressed={focus} onClick={() => chats.toggleFocus(callsign)}>
          <Focus size={12} />
          фокус
        </button>
        <a
          className="chat-mini"
          download={`${callsign.replace("@", "-")}.md`}
          href="#"
          onClick={(e) => {
            e.currentTarget.href = `data:text/markdown;charset=utf-8,${encodeURIComponent(exportMd(callsign, chats.conv(callsign).view))}`;
          }}
        >
          <Download size={12} />
          выгрузить .md
        </a>
      </div>
      {panel ? <Panel callsign={callsign} close={() => setPanel(false)} /> : null}
    </>
  );
}

function Feed({ callsign }: { callsign: string }) {
  const app = useApp();
  const chats = useModule<Chats>();
  const rows = app.use(() => chats.conv(callsign).view.rows);
  const focus = app.use(() => app.wide && chats.conv(callsign).focus);
  const more = app.use(() => chats.conv(callsign).more);
  const loaded = app.use(() => chats.conv(callsign).loaded);
  const refused = app.use(() => chats.conv(callsign).refused);
  const noFeed = app.use(() => app.can(machineOf(callsign) ?? "", "session.watch") === false);
  const list = useMemo(() => (focus ? focused(rows, chats.conv(callsign).view.tools) : rows), [focus, rows]); // eslint-disable-line react-hooks/exhaustive-deps

  const box = useRef<HTMLDivElement>(null);
  const atEnd = useRef(true);
  const [away, setAway] = useState(false);
  /** высота до страницы «Раньше»: лента остаётся на том же сообщении */
  const heightBefore = useRef<number | null>(null);

  useLayoutEffect(() => {
    const el = box.current!;
    if (heightBefore.current !== null) {
      el.scrollTop += el.scrollHeight - heightBefore.current;
      heightBefore.current = null;
    } else if (atEnd.current) el.scrollTop = el.scrollHeight;
  }, [list]);

  const toEnd = () => {
    const el = box.current!;
    el.scrollTop = el.scrollHeight;
    atEnd.current = true;
    setAway(false);
  };

  return (
    <div className="chat-feedw">
      <Pad
        className="chat-feed"
        aria-live="polite"
        ref={box as never}
        onScroll={(e) => {
          const el = e.currentTarget;
          atEnd.current = el.scrollHeight - el.clientHeight - el.scrollTop < AT_END_PX;
          setAway(!atEnd.current);
        }}
      >
        <div className="chat-col">
          {noFeed ? <div className="chat-note">{`${machineOf(callsign)} не отдаёт ленту — только переписка и ввод`}</div> : null}
          {more ? (
            <button
              type="button"
              className="chat-older"
              onClick={() => {
                heightBefore.current = box.current!.scrollHeight;
                void chats.older(callsign);
              }}
            >
              Раньше
            </button>
          ) : null}
          <Rows rows={list} />
          {refused ? (
            <div className="chat-note" role="alert">
              {refused}
            </div>
          ) : loaded && !noFeed && !rows.length ? (
            <div className="chat-note">Сообщений пока нет</div>
          ) : null}
          <Work callsign={callsign} />
        </div>
      </Pad>
      {away ? (
        <button type="button" className="chat-jump" aria-label="К последнему" onClick={toEnd}>
          <ArrowDown size={16} />
        </button>
      ) : null}
    </div>
  );
}

export function ChatScreen({ params }: ScreenProps) {
  const app = useApp();
  const chats = useModule<Chats>();
  const callsign = params.callsign;
  useEffect(() => chats.open(callsign), [callsign]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <EnvCtx.Provider value={chats.env(callsign)}>
      <div className={app.wide ? "chat wide" : "chat"}>
        {app.wide ? <Bar callsign={callsign} /> : null}
        <Feed callsign={callsign} />
        <Dock callsign={callsign} />
        <Composer key={callsign} callsign={callsign} />
      </div>
    </EnvCtx.Provider>
  );
}
