// Экран разговора: полоса (широко), лента или фокус, док над вводом и ввод.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Btn, isLive, Pad, sessionLabel, sessionOf, useApp, useModule, type Params } from "@switchboard/web-ui";
import { Download } from "lucide-react";
import { exportMd, focusItems, type Item } from "../focus.ts";
import { fold, type Row } from "../fold.ts";
import { machineOf, type Talks } from "../talk.ts";
import { Composer } from "./Composer.tsx";
import { Dock } from "./Dock.tsx";
import { EnvCtx, type Env } from "./env.ts";
import { Icon } from "./icons.tsx";
import { Panel } from "./Panel.tsx";
import { Dis, Reply, RowView } from "./Rows.tsx";

/** Ближе этого к низу лента считается у края и идёт за новыми строками. */
const AT_END_PX = 48;

function ItemView({ it }: { it: Item }) {
  if (it.k === "row") return it.only && it.row.k === "reply" ? <Reply r={it.row} only={it.only} /> : <RowView r={it.row} />;
  if (it.k === "service")
    return (
      <Dis className="chat-steps" head="служебные строки">
        {it.rows.map((r) => (
          <RowView key={r.key} r={r} />
        ))}
      </Dis>
    );
  return (
    <Dis
      className="chat-steps"
      head={
        <>
          <Icon name="list-collapse" />
          {it.head}
        </>
      }
    >
      {it.items.map((x, i) => (
        <ItemView key={i} it={x} />
      ))}
    </Dis>
  );
}

export function ChatScreen({ params }: { params: Params }) {
  const app = useApp();
  const talks = useModule<Talks>();
  const cs = params.callsign;
  const t = app.use(() => talks.get(cs));
  const state = app.use(() => sessionOf(app, cs)?.state as string | undefined);
  const call = app.use(() => app.can(machineOf(cs), "session.call") === true);
  const label = app.use(() => sessionLabel(app, cs).text);
  const live = isLive(state);
  const [panel, setPanel] = useState(false);
  const [jump, setJump] = useState(false);
  const feed = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const top = useRef(0);
  /** высота до страницы «Раньше»: лента остаётся на том же сообщении */
  const kept = useRef<number | null>(null);

  useEffect(() => {
    talks.open(cs);
    return () => talks.close(cs);
  }, [cs]); // eslint-disable-line react-hooks/exhaustive-deps

  const view = useMemo(() => fold(t.msgs), [t.msgs]);
  const sends = useMemo(() => Object.fromEntries(t.sends.map((s) => [s.uuid, s])), [t.sends]);
  const echoed = useMemo(() => new Set(view.rows.flatMap((r) => (r.k === "me" && r.uuid ? [r.uuid] : []))), [view]);
  const pending: Row[] = t.sends.filter((s) => !echoed.has(s.uuid)).map((s) => ({ k: "me", key: `send:${s.uuid}`, uuid: s.uuid, text: s.text, pics: [] }));
  const env: Env = {
    cs,
    wide: app.wide,
    canAct: live && call,
    view,
    sends,
    rewinds: t.rewinds,
    label: label,
    waiting: (id) => app.mark("asked.tool", cs, id) === true,
    act: (m, args) => void talks.act(cs, m, args),
    again: (u) => talks.again(cs, u),
    cancel: (u) => void talks.cancel(cs, u),
    rewind: (u, apply) => void talks.rewind(cs, u, apply),
    dropRewind: (u) => talks.edit(cs, (x) => void delete x.rewinds[u]),
    fill: (text) => talks.edit(cs, (x) => void (x.draft = text)),
  };
  const focus = app.wide && t.focus;
  const work = view.compacting ? "Сжимаю контекст…" : view.thinking !== undefined ? `размышляет · ${+(view.thinking / 1000).toFixed(1)} К` : state === "busy" ? "" : null;

  useLayoutEffect(() => {
    const el = feed.current;
    if (!el) return;
    if (kept.current !== null) el.scrollTop = el.scrollHeight - kept.current;
    else if (stick.current) el.scrollTop = el.scrollHeight;
    kept.current = null;
  }, [view, t.sends.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // лента у низа остаётся у низа, что бы ни выросло: поток текста, поле ввода, док над ним
  useEffect(() => {
    const el = feed.current!;
    const keep = new ResizeObserver(() => {
      if (stick.current) el.scrollTop = el.scrollHeight;
    });
    keep.observe(el);
    keep.observe(el.firstElementChild!);
    return () => keep.disconnect();
  }, []);

  const empty = !view.rows.length && !pending.length;
  return (
    <EnvCtx.Provider value={env}>
      <div className={app.wide ? "chat wide" : "chat"}>
        {app.wide && (
          <div className="chat-bar">
            {env.canAct && (
              <Btn type="button" className="chat-mini" aria-pressed={panel} onClick={() => setPanel(!panel)}>
                <Icon name="gauge" />
                контекст
              </Btn>
            )}
            <Btn type="button" className="chat-mini" aria-pressed={focus} onClick={() => talks.edit(cs, (x) => void (x.focus = !x.focus))}>
              <Icon name="focus" />
              фокус
            </Btn>
            <a
              className="chat-mini"
              download={`${cs.replace(/@/g, "-")}.md`}
              href="#"
              onClick={(e) => {
                e.currentTarget.href = `data:text/markdown;charset=utf-8,${encodeURIComponent(exportMd(cs, view))}`;
              }}
            >
              <Download size={13} aria-hidden="true" />
              выгрузить .md
            </a>
          </div>
        )}
        {panel && env.canAct && <Panel close={() => setPanel(false)} />}
        <div className="chat-feedw">
          <Pad
            className="chat-feed"
            aria-live="polite"
            ref={feed}
            onScroll={(e) => {
              // от низа уводит только прокрутка вверх: рост ленты стороной не считается
              const el = e.currentTarget;
              if (el.scrollHeight - el.clientHeight - el.scrollTop < AT_END_PX) stick.current = true;
              else if (el.scrollTop < top.current) stick.current = false;
              top.current = el.scrollTop;
              setJump(!stick.current);
            }}
          >
            <div className="chat-col">
              {t.more && (
                <button
                  type="button"
                  className="chat-older"
                  onClick={() => {
                    const el = feed.current!;
                    kept.current = el.scrollHeight - el.scrollTop;
                    void talks.older(cs).then((ok) => {
                      if (!ok) kept.current = null;
                    });
                  }}
                >
                  Раньше
                </button>
              )}
              {t.note && (
                <div className="chat-note" role={t.note.startsWith("session.") ? "alert" : undefined}>
                  {t.note}
                </div>
              )}
              {empty && !t.note && <div className="chat-note">Сообщений пока нет</div>}
              {focus ? focusItems(view).map((it, i) => <ItemView key={i} it={it} />) : view.rows.map((r) => <RowView key={r.key} r={r} />)}
              {pending.map((r) => (
                <RowView key={r.key} r={r} />
              ))}
              {work !== null && (
                <div className="chat-work">
                  <i />
                  <i />
                  <i />
                  {work}
                </div>
              )}
            </div>
          </Pad>
          {jump && (
            <button
              type="button"
              className="chat-jump"
              aria-label="Вниз"
              onClick={() => {
                const el = feed.current!;
                el.scrollTop = el.scrollHeight;
                stick.current = true;
                setJump(false);
              }}
            >
              <Icon name="arrow-down" size={16} />
            </button>
          )}
        </div>
        <Dock />
        <Composer />
      </div>
    </EnvCtx.Provider>
  );
}
