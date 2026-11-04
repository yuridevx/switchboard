// Экран разговора: полоса, лента, док и ввод. Лента — строки свёртки; фокус сворачивает шаги хода.
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, Download, Focus, Gauge, ListCollapse } from "lucide-react";
import type { ScreenProps } from "@switchboard/web-core";
import { Btn, IconBtn, Pad, sessionLabel, sessionOf, useApp, useModule } from "@switchboard/web-ui";
import type { Chat } from "./state/chat.ts";
import { focusRows, type Steps } from "./state/focus.ts";
import { steps as stepsWord } from "./state/words.ts";
import { Composer } from "./view/Composer.tsx";
import { Dock } from "./view/Dock.tsx";
import { Dis, EnvCtx, type Env } from "./view/env.tsx";
import { toolWord } from "./view/kinds.tsx";
import { Panel } from "./view/Panel.tsx";
import { Rows } from "./view/Rows.tsx";

const NEAR_BOTTOM = 80;

/** Внизу ли лента: новое подкручивается, только пока человек не ушёл вверх. */
function useStick() {
  const box = useRef<HTMLDivElement>(null);
  const col = useRef<HTMLDivElement>(null);
  const stuck = useRef(true);
  const lastTop = useRef(0);
  const [away, setAway] = useState(false);
  // содержимое растёт и без новой строки: кусочки, картинки, раскрытые карточки
  useLayoutEffect(() => {
    const el = box.current;
    if (!el || !col.current || typeof ResizeObserver === "undefined") return;
    const seen = new ResizeObserver(() => {
      if (stuck.current) el.scrollTop = el.scrollHeight;
    });
    seen.observe(col.current);
    seen.observe(el);
    return () => seen.disconnect();
  }, []);
  const onScroll = () => {
    const el = box.current;
    if (!el) return;
    // от низа уводит только прокрутка вверх; выросшее содержимое низ не отбирает
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM;
    if (near) stuck.current = true;
    else if (el.scrollTop < lastTop.current) stuck.current = false;
    lastTop.current = el.scrollTop;
    setAway(!stuck.current);
  };
  const jump = () => {
    const el = box.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    lastTop.current = el.scrollTop;
    stuck.current = true;
    setAway(false);
  };
  return { box, col, away, onScroll, jump };
}

/** Сводка: «12 шагов · Команда ×5 · Правка ×3 · размышлял». */
function stepsLine(s: Steps): string {
  const counts = Object.entries(s.tools).sort((a, b) => b[1] - a[1]);
  const total = counts.reduce((n, [, k]) => n + k, 0);
  const names = counts.map(([name, k]) => `${toolWord(name)}${k > 1 ? ` ×${k}` : ""}`);
  return [total ? stepsWord(total) : null, ...names, s.thought ? "размышлял" : null].filter(Boolean).join(" · ") || "служебные строки";
}

const StepsRow = memo(function StepsRow({ steps }: { steps: Steps }) {
  return (
    <Dis
      className="chat-steps"
      head={
        <>
          <ListCollapse size={14} />
          {stepsLine(steps)}
        </>
      }
    >
      <Rows rows={steps.rows} />
    </Dis>
  );
});

/** Внизу ленты: идёт сжатие или ход. */
function Working({ compacting, thinking, busy }: { compacting: boolean; thinking: number; busy: boolean }) {
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

function Bar({ callsign, panel, setPanel }: { callsign: string; panel: boolean; setPanel(v: boolean): void }) {
  const app = useApp();
  const chat = useModule<Chat>();
  const focus = app.use(() => chat.conv(callsign).focus);
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
  const callsign = params.callsign;
  const app = useApp();
  const chat = useModule<Chat>();
  const c = app.use(() => chat.conv(callsign));
  const busy = app.use(() => sessionOf(app, callsign)?.state === "busy");
  const canCall = app.use(() => chat.canCall(callsign));
  const name = app.use(() => sessionLabel(app, callsign).text);
  const machine = chat.machineOf(callsign);
  const noFeed = app.use(() => app.can(machine, "session.watch") === false);
  const [panel, setPanel] = useState(false);
  const view = c.view;

  useEffect(() => {
    chat.mount(callsign);
    return () => chat.unmount(callsign);
  }, [chat, callsign]);

  const { box, col, away, onScroll, jump } = useStick();
  const env = useMemo<Env>(
    () => ({
      callsign,
      view,
      sends: c.sends,
      rewind: c.rewind,
      canCall,
      wide: app.wide,
      label: () => name,
      useWaiting: (id) => app.use(() => app.mark("asked.tool", callsign, id) === true),
      act: (m, a) => void chat.act(callsign, m, a),
      fillText: (t) => chat.fillText(callsign, t),
      again: (u) => chat.again(callsign, u),
      cancel: (u) => void chat.cancel(callsign, u),
      probeRewind: (u) => void chat.probeRewind(callsign, u),
      applyRewind: (u) => void chat.applyRewind(callsign, u),
      cancelRewind: () => chat.cancelRewind(callsign),
    }),
    [callsign, view, c.sends, c.rewind, canCall, name, app, chat],
  );

  const items = useMemo(() => (app.wide && c.focus ? focusRows(view) : null), [app.wide, c.focus, view]);
  const empty = !view.rows.length && !noFeed;
  return (
    <EnvCtx.Provider value={env}>
      <div className={app.wide ? "chat wide" : "chat"}>
        {app.wide ? <Bar callsign={callsign} panel={panel} setPanel={setPanel} /> : null}
        {panel ? <Panel callsign={callsign} close={() => setPanel(false)} /> : null}
        <div className="chat-feedw">
          <Pad ref={box} className="chat-feed" aria-live="polite" onScroll={onScroll}>
            <div className="chat-col" ref={col}>
              {noFeed ? <div className="chat-note">{`${machine} не отдаёт ленту — только переписка и ввод`}</div> : null}
              {c.more ? (
                <Btn type="button" className="chat-older" onClick={() => void chat.older(callsign)}>
                  Раньше
                </Btn>
              ) : null}
              {items ? items.map((it) => ("row" in it ? <Rows key={it.id} rows={[it.row]} /> : <StepsRow key={it.id} steps={it.steps} />)) : <Rows rows={view.rows} />}
              {c.error ? (
                <div className="chat-note" role="alert">
                  {c.error}
                </div>
              ) : empty ? (
                <div className="chat-note">Сообщений пока нет</div>
              ) : null}
              <Working compacting={view.compacting} thinking={view.thinking} busy={busy} />
            </div>
          </Pad>
          {away ? (
            <IconBtn className="chat-jump" aria-label="К последнему" onClick={jump}>
              <ArrowDown size={16} />
            </IconBtn>
          ) : null}
        </div>
        <Dock callsign={callsign} view={view} sides={c.sides} />
        <Composer callsign={callsign} />
      </div>
    </EnvCtx.Provider>
  );
}
