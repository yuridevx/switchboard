// Экран разговора: полоса (широко), лента или фокус, док над вводом и ввод.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Btn, IconBtn, Pad, sessionLabel, sessionOf, useApp, useModule, type Params } from "@switchboard/web-ui";
import { exportMd, focused, type Item } from "../focus.ts";
import { fold, type View } from "../fold.ts";
import { machineOf, type Talks } from "../talk.ts";
import { Composer } from "./Composer.tsx";
import { Dock } from "./Dock.tsx";
import { EnvCtx, type Env } from "./env.ts";
import { Icon } from "./icons.tsx";
import { Panel } from "./Panel.tsx";
import { Dis, RowView, Rows } from "./Rows.tsx";

/** Ближе этого к низу лента считается у края и идёт за новыми строками. */
const AT_END_PX = 48;
const tokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)} К` : String(n));

function ItemView({ it }: { it: Item }) {
  if (it.k !== "steps") return <RowView r={it} />;
  return (
    <Dis
      className="chat-steps"
      head={
        <>
          <Icon name="list-collapse" size={14} />
          {it.title}
        </>
      }
    >
      <Rows rows={it.rows} />
    </Dis>
  );
}

function Work({ cs, view }: { cs: string; view: View }) {
  const app = useApp();
  const busy = app.use(() => sessionOf(app, cs)?.state === "busy");
  if (view.compacting) return <div className="chat-work">Сжимаю контекст…</div>;
  if (!busy) return null;
  return (
    <div className="chat-work">
      <i />
      <i />
      <i />
      {view.thinking ? `размышляет · ${tokens(view.thinking)}` : ""}
    </div>
  );
}

function Bar({ cs, view, focus }: { cs: string; view: View; focus: boolean }) {
  const talks = useModule<Talks>();
  const app = useApp();
  const canAct = app.use(() => talks.canAct(cs));
  const [panel, setPanel] = useState(false);
  return (
    <>
      <div className="chat-bar">
        {canAct ? (
          <Btn type="button" className="chat-mini" aria-pressed={panel} onClick={() => setPanel(!panel)}>
            <Icon name="gauge" />
            контекст
          </Btn>
        ) : null}
        <Btn type="button" className="chat-mini" aria-pressed={focus} onClick={() => talks.edit(cs, (t) => void (t.focus = !t.focus))}>
          <Icon name="focus" />
          фокус
        </Btn>
        <a
          className="chat-mini"
          download={`${cs.replace("@", "-")}.md`}
          href="#"
          onClick={(e) => {
            e.currentTarget.href = `data:text/markdown;charset=utf-8,${encodeURIComponent(exportMd(cs, view))}`;
          }}
        >
          <Icon name="download" />
          выгрузить .md
        </a>
      </div>
      {panel && canAct ? <Panel cs={cs} close={() => setPanel(false)} /> : null}
    </>
  );
}

function Feed({ cs, view, focus }: { cs: string; view: View; focus: boolean }) {
  const app = useApp();
  const talks = useModule<Talks>();
  const more = app.use(() => talks.get(cs).more);
  const loaded = app.use(() => talks.get(cs).loaded);
  const refused = app.use(() => talks.get(cs).refused);
  const noFeed = app.use(() => app.can(machineOf(cs), "session.watch") === false);
  const items = useMemo(() => (focus ? focused(view) : view.rows), [focus, view]);
  const box = useRef<HTMLDivElement>(null);
  const atEnd = useRef(true);
  const lastTop = useRef(0);
  /** высота до страницы «Раньше»: лента остаётся на том же сообщении */
  const heightBefore = useRef<number | null>(null);
  const [away, setAway] = useState(false);

  useLayoutEffect(() => {
    const el = box.current!;
    if (heightBefore.current !== null) el.scrollTop += el.scrollHeight - heightBefore.current;
    else if (atEnd.current) el.scrollTop = el.scrollHeight;
    heightBefore.current = null;
  }, [items]);

  // лента у низа остаётся у низа, что бы ни выросло: поток текста, поле ввода, док над ним
  useEffect(() => {
    const el = box.current!;
    const keep = new ResizeObserver(() => {
      if (atEnd.current) el.scrollTop = el.scrollHeight;
    });
    keep.observe(el);
    keep.observe(el.firstElementChild!);
    return () => keep.disconnect();
  }, []);

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
        ref={box}
        onScroll={(e) => {
          // от низа уводит только прокрутка вверх: рост ленты стороной не считается
          const el = e.currentTarget;
          const near = el.scrollHeight - el.clientHeight - el.scrollTop < AT_END_PX;
          if (near || el.scrollTop < lastTop.current) atEnd.current = near;
          lastTop.current = el.scrollTop;
          setAway(!atEnd.current);
        }}
      >
        <div className="chat-col">
          {noFeed ? <div className="chat-note">{`${machineOf(cs)} не отдаёт ленту — только переписка и ввод`}</div> : null}
          {more ? (
            <button
              type="button"
              className="chat-older"
              onClick={() => {
                heightBefore.current = box.current!.scrollHeight;
                void talks.older(cs).then((ok) => {
                  if (!ok) heightBefore.current = null;
                });
              }}
            >
              Раньше
            </button>
          ) : null}
          {items.map((it) => (
            <ItemView key={it.key} it={it} />
          ))}
          {refused ? (
            <div className="chat-note" role="alert">
              {refused}
            </div>
          ) : loaded && !noFeed && !view.rows.length ? (
            <div className="chat-note">Сообщений пока нет</div>
          ) : null}
          <Work cs={cs} view={view} />
        </div>
      </Pad>
      {away ? (
        <IconBtn className="chat-jump" aria-label="К последнему" onClick={toEnd}>
          <Icon name="arrow-down" size={16} />
        </IconBtn>
      ) : null}
    </div>
  );
}

export function ChatScreen({ params }: { params: Params }) {
  const app = useApp();
  const talks = useModule<Talks>();
  const cs = params.callsign;
  const msgs = app.use(() => talks.get(cs).msgs);
  const sendList = app.use(() => talks.get(cs).sends);
  const rewind = app.use(() => talks.get(cs).rewind);
  const canAct = app.use(() => talks.canAct(cs));
  const label = app.use(() => sessionLabel(app, cs).text);
  const focus = app.use(() => app.wide && talks.get(cs).focus);

  useEffect(() => {
    talks.open(cs);
    return () => talks.close(cs);
  }, [cs]); // eslint-disable-line react-hooks/exhaustive-deps

  const view = useMemo(() => fold(msgs), [msgs]);
  const sends = useMemo(() => Object.fromEntries(sendList.map((s) => [s.uuid, s])), [sendList]);
  const env: Env = {
    cs,
    wide: app.wide,
    canAct,
    view,
    sends,
    rewind,
    label,
    waiting: (id) => app.mark("asked.tool", cs, id) === true,
    act: (m, args) => void talks.act(cs, m, args),
    again: (u) => talks.again(cs, u),
    cancel: (u) => void talks.cancel(cs, u),
    probe: (u) => void talks.probe(cs, u),
    apply: (u) => void talks.apply(cs, u),
    cancelRewind: () => talks.edit(cs, (t) => void (t.rewind = null)),
    fill: (text) => talks.edit(cs, (t) => void (t.draft = text)),
  };
  return (
    <EnvCtx.Provider value={env}>
      <div className={app.wide ? "chat wide" : "chat"}>
        {app.wide ? <Bar cs={cs} view={view} focus={focus} /> : null}
        <Feed cs={cs} view={view} focus={focus} />
        <Dock />
        <Composer key={cs} />
      </div>
    </EnvCtx.Provider>
  );
}
