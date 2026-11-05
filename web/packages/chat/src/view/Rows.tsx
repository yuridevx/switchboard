// Строки ленты: каждая рисует свои данные из свёртки. Контекст Env — действия и живые сведения; галерея стенда подаёт свой.
import { createContext, memo, useContext, useState, type ReactNode } from "react";
import { Anchor, Archive, ArrowLeftRight, Ban, BookOpen, Bot, BrainCircuit, ChevronDown, ChevronRight, ChevronUp, FileText, FileUp, Gauge, History, Info, ListCollapse, MessagesSquare, Pencil, RefreshCw, RotateCcw, RotateCw, ShieldOff, Shuffle, Sparkles, Square, Terminal, TriangleAlert, Undo2, X, Zap } from "lucide-react";
import { Btn, CodeBlock, CopyButton, DisclosureBtn, Markdown, permModeName, plural, TextBtn, useApp } from "@switchboard/web-ui";
import type { Part, Row } from "../fold.ts";
import type { Steps } from "../focus.ts";
import type { Env } from "../store.ts";
import { ToolCard } from "./Tool.tsx";

export const EnvCtx = createContext<Env | null>(null);
export const useEnv = () => useContext(EnvCtx)!;

const ICONS: Record<string, typeof Zap> = { archive: Archive, "refresh-cw": RefreshCw, zap: Zap, "shield-off": ShieldOff, "arrow-left-right": ArrowLeftRight, gauge: Gauge, shuffle: Shuffle, anchor: Anchor, memory: BookOpen, info: Info, x: X, ban: Ban, file: FileUp, reset: RotateCcw, bot: Bot, terminal: Terminal, stop: Square, model: Sparkles };
const Icon = ({ name, size = 13 }: { name?: string; size?: number }) => {
  const I = name ? ICONS[name] : undefined;
  return I ? <I size={name === "stop" ? 11 : size} /> : null;
};

/** Свёрнутая строка: заголовок и тело по нажатию. */
export function Dis({ className, head, children, open: first = false }: { className?: string; head: ReactNode; children?: ReactNode; open?: boolean }) {
  const [open, setOpen] = useState(first);
  return (
    <div className={`dis ${className ?? ""}`.trim()}>
      <DisclosureBtn className="dis-h" open={open} onClick={() => setOpen(!open)}>
        {head}
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      </DisclosureBtn>
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
      <BrainCircuit size={14} />
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
    if (!send) return "";
    if (send.state === "sending") return "отправляю…";
    if (send.queued && send.state === "ok") return env.wide ? "в очереди · ✓" : "в очереди";
    return `${row.at} · ${env.wide ? (send.state === "echo" ? "✓✓" : "✓") : "доставлено"}`;
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
          {"связь оборвалась до ответа — "}
          <span className="chat-nb">не подтверждено ·</span>{" "}
          <TextBtn className="chat-again" onClick={() => env.again(row.id)}>
            <RotateCw size={11} />
            отправить ещё раз
          </TextBtn>
        </small>
      ) : stamp() ? (
        <small>{stamp()}</small>
      ) : null}
      {send?.queued && send.state === "ok" && canAct ? (
        <TextBtn className="chat-again chat-cancel" onClick={() => env.cancel(row.id)}>
          <Undo2 size={11} />
          отменить
        </TextBtn>
      ) : null}
      {env.wide && canAct && (!send || send.state === "echo" || send.state === "ok") ? (
        <TextBtn className="chat-rw" onClick={() => env.probe(row.id)}>
          <History size={11} />
          откатить файлы
        </TextBtn>
      ) : null}
    </div>
  );
}

function Rewind({ id }: { id: string }) {
  const app = useApp();
  const env = useEnv();
  const rw = app.use(() => env.rewind());
  if (!rw || rw.id !== id) return null;
  return (
    <div className={`chat-rwc ${rw.state === "bad" || rw.state === "ok" ? rw.state : ""}`} role="status">
      <span>{rw.text}</span>
      {rw.state === "ask" ? (
        <>
          <Btn type="button" className="chat-mini" onClick={env.cancelRewind}>
            Отмена
          </Btn>
          <Btn type="button" bad className="chat-mini" onClick={() => env.apply(id)}>
            Откатить
          </Btn>
        </>
      ) : null}
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
    <div className={row.via === "owner" ? "chat-in" : "chat-in fleet"} data-from={row.via === "owner" ? undefined : row.via}>
      <div className="chat-from">
        {row.via === "agent" ? <Bot size={13} /> : row.via === "session" ? <MessagesSquare size={13} /> : null}
        {from}
        {row.tag ? <span className="chat-tag">{row.via === "owner" ? row.tag : (permModeName(row.tag)?.toLowerCase() ?? row.tag)}</span> : null}
      </div>
      {row.via === "owner" ? (
        <Markdown text={row.text} />
      ) : (
        <div className={long && !whole ? "chat-clamp" : ""}>
          <Markdown text={row.text} />
        </div>
      )}
      {long ? (
        <DisclosureBtn className="chat-more" open={whole} onClick={() => setWhole(!whole)}>
          {whole ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
          {whole ? "свернуть" : "показать всё"}
        </DisclosureBtn>
      ) : null}
      {row.at ? <small>{row.at}</small> : null}
    </div>
  );
}

function Banner({ row }: { row: Extract<Row, { k: "ban" }> }) {
  const env = useEnv();
  const edit = row.edit;
  return (
    <div className={`chat-ban ${row.tone}`} {...(row.tone === "bad" ? { role: "alert" } : {})}>
      <Icon name={row.icon ?? (row.tone === "bad" ? "x" : "info")} size={15} />
      <div>
        <b>{row.title}</b>
        {row.body ? <p>{row.body}</p> : null}
        {edit !== undefined ? (
          <Btn type="button" className="chat-mini" onClick={() => env.fill(edit)}>
            <Pencil size={12} />
            Изменить сообщение
          </Btn>
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
      {task.type === "local_agent" ? <Bot size={13} /> : <Terminal size={13} />}
      <span>{[task.desc, task.summary].filter(Boolean).join(" · ")}</span>
      <em>{`${task.steps ?? 0} ${plural(task.steps ?? 0, "шаг", "шага", "шагов")}`}</em>
      {canAct ? (
        <Btn type="button" className="chat-mini" onClick={() => env.act("stopTask", [id])}>
          <Square size={11} />
          Стоп
        </Btn>
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
            <Zap size={12} />
            {row.args ? `${row.name} ${row.args}` : row.name}
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
              <Archive size={13} />
              {row.stats}
            </>
          }
        >
          <Markdown text={row.text} />
        </Dis>
      );
    case "res":
      return (
        <div className="chat-res">
          {row.bits.map((bit, i) => (
            <span key={i}>
              {i ? " · " : ""}
              <span className="chat-nb">{bit}</span>
            </span>
          ))}
        </div>
      );
    case "end":
      return (
        <div className="chat-res err">
          <TriangleAlert size={13} />
          {row.text}
          {row.why ? <p>{row.why}</p> : null}
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
              <ListCollapse size={14} />
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
