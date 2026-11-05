// Строки ленты: каждая рисует свои данные из свёртки. Контекст Env — действия и живые сведения; галерея стенда подаёт свой.
import { createContext, memo, useContext, useState, type ReactNode } from "react";
import { AlertTriangle, Anchor, Archive, ArrowLeftRight, Ban, BookOpen, Bot, BrainCircuit, ChevronDown, ChevronRight, ChevronUp, FileText, FileUp, Gauge, History, Info, ListCollapse, Loader2, MessagesSquare, Pencil, RefreshCw, RotateCcw, RotateCw, ShieldOff, Shuffle, SquareSlash, Undo2, Zap } from "lucide-react";
import { CodeBlock, CopyButton, Markdown, plural, useApp } from "@switchboard/web-ui";
import type { Part, Row } from "../fold.ts";
import type { Steps } from "../focus.ts";
import type { Env } from "../store.ts";
import { ToolCard } from "./Tool.tsx";

export const EnvCtx = createContext<Env | null>(null);
export const useEnv = () => useContext(EnvCtx)!;

const ICONS: Record<string, typeof Zap> = { archive: Archive, "refresh-cw": RefreshCw, zap: Zap, "shield-off": ShieldOff, "arrow-left-right": ArrowLeftRight, gauge: Gauge, shuffle: Shuffle, anchor: Anchor, memory: BookOpen, info: Info, ban: Ban, file: FileUp, reset: RotateCcw };
const Icon = ({ name, fallback }: { name?: string; fallback?: typeof Zap }) => {
  const I = name ? ICONS[name] : fallback;
  return I ? <I size={13} /> : null;
};

/** Свёрнутая строка: заголовок и тело по нажатию. */
export function Dis({ className, head, children, open: first = false }: { className?: string; head: ReactNode; children?: ReactNode; open?: boolean }) {
  const [open, setOpen] = useState(first);
  return (
    <div className={`dis ${className ?? ""}`.trim()}>
      <button type="button" className="dis-h" aria-expanded={open} onClick={() => setOpen(!open)}>
        {head}
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      </button>
      {open ? <div className="dis-b">{children}</div> : null}
    </div>
  );
}

const DOC = /^\s*(<!doctype html|<html[\s>])/i;

function Text({ part }: { part: Extract<Part, { t: "text" }> }) {
  // целый документ: готовый — блок с просмотром, пишущийся — как текст
  if (!part.live && DOC.test(part.text)) return <CodeBlock code={part.text.trim()} lang="html" />;
  return (
    <div className="chat-txt">
      <Markdown text={part.text} live={part.live} />
    </div>
  );
}

const THINK_TAIL = 400;

function Think({ part }: { part: Extract<Part, { t: "think" }> }) {
  const label = (text: string) => (
    <>
      <BrainCircuit size={13} />
      {text}
    </>
  );
  if (part.live) {
    return (
      <div className="chat-think live">
        <div className="chat-think-h">{label("Размышляет…")}</div>
        <div className="chat-think-t">{part.text.slice(-THINK_TAIL)}</div>
      </div>
    );
  }
  if (!part.text) {
    return (
      <div className="chat-think">
        <div className="chat-think-h">{label("Размышлял")}</div>
      </div>
    );
  }
  return (
    <Dis className="chat-think" head={label("Размышлял")}>
      <div className="chat-think-t">
        <Markdown text={part.text} />
      </div>
    </Dis>
  );
}

function Reply({ row }: { row: Extract<Row, { k: "reply" }> }) {
  const texts = row.parts.flatMap((p) => (p.t === "text" ? [p] : []));
  const ready = texts.length > 0 && !texts.some((p) => p.live);
  return (
    <div className="chat-reply">
      {row.parts.map((p, i) => (p.t === "text" ? <Text key={i} part={p} /> : p.t === "think" ? <Think key={i} part={p} /> : <ToolCard key={p.id} id={p.id} />))}
      {ready ? (
        <div className="chat-acts">
          <CopyButton text={texts.map((p) => p.text).join("\n\n")} label="копировать" />
        </div>
      ) : null}
    </div>
  );
}

function Me({ row }: { row: Extract<Row, { k: "me" }> }) {
  const app = useApp();
  const env = useEnv();
  const send = app.use(() => env.send(row.id));
  const canAct = app.use(() => env.canAct());
  const lost = send?.state === "lost";
  const stamp = () => {
    if (!send) return row.at;
    if (send.state === "sending") return "отправляю…";
    if (send.queued && send.state === "sent") return app.wide ? "в очереди · ✓" : "в очереди";
    return `${row.at} · ${app.wide ? (send.state === "echo" ? "✓✓" : "✓") : "доставлено"}`;
  };
  return (
    <div className={lost ? "chat-me pend" : "chat-me"} data-state={send?.state}>
      {row.pics.length ? (
        <div className="chat-pics">
          {row.pics.map((src, i) => (
            <a key={i} href={src} target="_blank" rel="noopener noreferrer">
              <img src={src} alt={`картинка ${i + 1}`} />
            </a>
          ))}
        </div>
      ) : null}
      {row.files.map((f, i) => (
        <span key={i} className="chat-att">
          <FileText size={12} />
          {f}
        </span>
      ))}
      {row.text}
      {lost ? (
        <small>
          {"связь оборвалась до ответа — не подтверждено · "}
          <button type="button" className="chat-again" onClick={() => env.again(row.id)}>
            <RotateCw size={11} />
            отправить ещё раз
          </button>
        </small>
      ) : (
        <small>{stamp()}</small>
      )}
      {send?.queued && send.state === "sent" && canAct ? (
        <button type="button" className="chat-again chat-cancel" onClick={() => env.cancel(row.id)}>
          <Undo2 size={11} />
          отменить
        </button>
      ) : null}
      {app.wide && canAct && (!send || send.state === "sent" || send.state === "echo") && !send?.queued ? (
        <button type="button" className="chat-rw" onClick={() => env.probe(row.id)}>
          <History size={11} />
          откатить файлы
        </button>
      ) : null}
    </div>
  );
}

function Rewind({ id }: { id: string }) {
  const app = useApp();
  const env = useEnv();
  const rw = app.use(() => env.rewind());
  if (!rw || rw.id !== id) return null;
  if (rw.state !== "ask") {
    return (
      <div className={rw.state === "probe" ? "chat-rwc" : `chat-rwc ${rw.state}`} role={rw.state === "bad" ? "alert" : "status"}>
        {rw.text}
      </div>
    );
  }
  return (
    <div className="chat-rwc" role="status">
      <span>{rw.text}</span>
      <button type="button" className="chat-mini" onClick={env.cancelRewind}>
        Отмена
      </button>
      <button type="button" className="chat-mini bad" onClick={() => env.apply(id)}>
        Откатить
      </button>
    </div>
  );
}

const CLAMP_AT = 700;

function Incoming({ row }: { row: Extract<Row, { k: "in" }> }) {
  const env = useEnv();
  const long = row.via !== "owner" && row.text.length > CLAMP_AT;
  const [whole, setWhole] = useState(false);
  const from = row.via === "owner" ? `${env.label(row.from)} → вам` : row.via === "agent" ? `субагент · ${row.from}` : row.from ? `сессия Claude · ${row.from}` : "сессия Claude";
  return (
    <div className={row.via === "owner" ? "chat-in" : "chat-in fleet"} data-from={row.via}>
      <div className="chat-from">
        {row.via === "agent" ? <Bot size={12} /> : row.via === "session" ? <MessagesSquare size={12} /> : null}
        <span>{from}</span>
        {row.tag ? <span className="chat-tag">{row.via === "owner" ? row.tag : (MODE_TAGS[row.tag] ?? row.tag)}</span> : null}
      </div>
      <div className={long && !whole ? "chat-clamp" : undefined}>
        <Markdown text={row.text} />
      </div>
      {long ? (
        <button type="button" className="chat-more" onClick={() => setWhole(!whole)}>
          {whole ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
          {whole ? "свернуть" : "показать всё"}
        </button>
      ) : null}
      {row.at ? <small>{row.at}</small> : null}
    </div>
  );
}

const MODE_TAGS: Record<string, string> = { plan: "режим плана", acceptEdits: "правки сами", bypassPermissions: "без вопросов", auto: "авто" };

function Banner({ row }: { row: Extract<Row, { k: "ban" }> }) {
  const env = useEnv();
  const edit = row.edit;
  return (
    <div className={`chat-ban ${row.tone}`}>
      <Icon name={row.icon} fallback={row.tone === "bad" ? AlertTriangle : Info} />
      <div>
        <b>{row.title}</b>
        {row.body ? <p>{row.body}</p> : null}
        {edit !== undefined ? (
          <button type="button" className="chat-mini" onClick={() => env.fill(edit)}>
            <Pencil size={12} />
            Изменить сообщение
          </button>
        ) : null}
      </div>
    </div>
  );
}

function RunningTask({ id }: { id: string }) {
  const app = useApp();
  const env = useEnv();
  const task = app.use(() => env.view().tasks[id]);
  const canAct = app.use(() => env.canAct());
  if (!task) return null;
  return (
    <div className="chat-line run">
      {task.type === "local_agent" ? <Bot size={13} /> : <Loader2 size={13} />}
      <span>{[task.desc, task.summary].filter(Boolean).join(" · ")}</span>
      <em>{`${task.steps ?? 0} ${plural(task.steps ?? 0, "шаг", "шага", "шагов")}`}</em>
      {canAct ? (
        <button type="button" className="chat-mini" onClick={() => env.act("stopTask", [id])}>
          Стоп
        </button>
      ) : null}
    </div>
  );
}

function Plain({ row }: { row: Row }) {
  switch (row.k) {
    case "sys":
      return (
        <div className={row.tone ? `chat-sys ${row.tone}` : "chat-sys"}>
          <Icon name={row.icon} />
          {row.text}
        </div>
      );
    case "line":
      return (
        <div className={row.tone ? `chat-line ${row.tone}` : "chat-line"}>
          <Icon name={row.icon} />
          <span>
            {row.text}
            {row.dim ? <span className="chat-dim">{row.dim}</span> : null}
          </span>
        </div>
      );
    case "cmd":
      return (
        <div className="chat-cmd">
          <span>
            <SquareSlash size={12} />
            {row.name}
            {row.args ? ` ${row.args}` : ""}
          </span>
          {row.out ? <pre>{row.out}</pre> : null}
        </div>
      );
    case "sum":
      return (
        <Dis
          className="chat-sum"
          head={
            <>
              <Archive size={12} />
              {row.stats}
            </>
          }
        >
          <Markdown text={row.text} />
        </Dis>
      );
    case "res":
      return row.err ? (
        <div className="chat-res err">
          {row.text}
          {row.why ? <p>{row.why}</p> : null}
        </div>
      ) : (
        <div className="chat-res">
          {row.text}
          {row.context ? (
            <>
              {" · "}
              <span className="chat-nb">{row.context}</span>
            </>
          ) : null}
        </div>
      );
    default:
      return null;
  }
}

export const RowView = memo(function RowView({ row }: { row: Row | Steps }) {
  switch (row.k) {
    case "reply":
      return <Reply row={row} />;
    case "me":
      return (
        <>
          <Me row={row} />
          <Rewind id={row.id} />
        </>
      );
    case "in":
      return <Incoming row={row} />;
    case "ban":
      return <Banner row={row} />;
    case "task":
      return <RunningTask id={row.id} />;
    case "steps":
      return (
        <Dis
          className="chat-steps"
          head={
            <>
              <ListCollapse size={13} />
              {row.title}
            </>
          }
        >
          <Rows rows={row.rows} />
        </Dis>
      );
    default:
      return <Plain row={row} />;
  }
});

export function Rows({ rows }: { rows: Array<Row | Steps> }) {
  return rows.map((r) => <RowView key={r.id} row={r} />);
}
