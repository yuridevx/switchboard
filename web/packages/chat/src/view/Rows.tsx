// Строки ленты: каждому виду строки — своя разметка. Те же строки рисуются в ленте, в шагах субагента и в галерее.
import { memo, useState, type ReactNode } from "react";
import { AlertTriangle, Anchor, Archive, ArrowLeftRight, Ban, BookOpen, Bot, BrainCircuit, ChevronDown, ChevronUp, FileText, FileUp, Gauge, History, Info, MessagesSquare, Pencil, RefreshCw, RotateCcw, RotateCw, ShieldOff, Shuffle, Sparkles, Square, Terminal, Undo2, X, Zap } from "lucide-react";
import { Btn, CodeBlock, CopyButton, DisclosureBtn, hhmm, Markdown, permModeName, TextBtn } from "@switchboard/web-ui";
import type { Icon, Part, Row } from "../state/fold.ts";
import { taskEndText } from "../state/fold.ts";
import { kTokens, modelName, steps } from "../state/words.ts";
import { Dis, useEnv } from "./env.tsx";
import { ToolCard } from "./ToolCard.tsx";

const DOCUMENT = /^\s*(<!doctype html|<html[\s>])/i;
/** Длиннее — свёрнуто. */
const LONG = 700;
const LIVE_TAIL = 400;

const BIG = 15;
const ICONS: Record<Icon, (size: number) => ReactNode> = {
  archive: (s) => <Archive size={s} />,
  stop: () => <Square size={11} />,
  retry: (s) => <RefreshCw size={s} />,
  gauge: (s) => <Gauge size={s} />,
  zap: (s) => <Zap size={s} />,
  x: (s) => <X size={s} />,
  model: (s) => <Sparkles size={s} />,
  info: (s) => <Info size={s} />,
  ban: (s) => <Ban size={s} />,
  reset: (s) => <RotateCcw size={s} />,
  shuffle: (s) => <Shuffle size={s} />,
  anchor: (s) => <Anchor size={s} />,
  memory: (s) => <BookOpen size={s} />,
  file: (s) => <FileUp size={s} />,
  swap: (s) => <ArrowLeftRight size={s} />,
};

function Think({ part }: { part: Extract<Part, { k: "think" }> }) {
  const t = part.text.trim();
  const head = (
    <>
      <BrainCircuit size={14} />
      {part.live ? "Размышляет…" : "Размышлял"}
    </>
  );
  // пока идёт — последние строки; потом свёрнутая строка, по нажатию весь текст
  if (part.live)
    return (
      <div className="chat-think live">
        <div className="chat-think-h">{head}</div>
        {t ? <div className="chat-think-t">{t.slice(-LIVE_TAIL)}</div> : null}
      </div>
    );
  if (!t)
    return (
      <div className="chat-think">
        <div className="chat-think-h">{head}</div>
      </div>
    );
  return (
    <Dis className="chat-think" head={head}>
      <div className="chat-think-t">
        <Markdown text={t} />
      </div>
    </Dis>
  );
}

function PartView({ part }: { part: Part }) {
  if (part.k === "think") return <Think part={part} />;
  if (part.k === "tool") return <ToolCard id={part.tool} />;
  // полный HTML-документ показывается кодом, а не разбирается как разметка
  if (!part.live && DOCUMENT.test(part.text)) return <CodeBlock code={part.text.trim()} lang="html" />;
  return (
    <div className="chat-txt">
      <Markdown text={part.text} live={part.live} />
    </div>
  );
}

function Reply({ row }: { row: Extract<Row, { k: "reply" }> }) {
  const texts = row.parts.flatMap((p) => (p.k === "text" ? [p] : []));
  const text = texts.map((p) => p.text).join("\n\n");
  return (
    <div className="chat-reply">
      {row.parts.map((p) => (
        <PartView key={p.pid} part={p} />
      ))}
      {text && !texts.some((p) => p.live) ? (
        <div className="chat-acts">
          <CopyButton text={text} label="копировать" />
        </div>
      ) : null}
    </div>
  );
}

/** Подпись под своим сообщением: узко — словами, широко — галочками. */
function Tail({ uuid }: { uuid: string }) {
  const env = useEnv();
  const s = env.sends[uuid];
  if (!s) return null;
  if (s.state === "lost")
    return (
      <small>
        связь оборвалась до ответа — <span className="chat-nb">не подтверждено ·</span>{" "}
        <TextBtn className="chat-again" onClick={() => env.again(uuid)}>
          <RotateCw size={11} />
          отправить ещё раз
        </TextBtn>
      </small>
    );
  if (s.state === "sending") return <small>отправляю…</small>;
  const at = hhmm(s.at);
  if (s.state === "echo") return <small>{env.wide ? `${at} · ✓✓` : `${at} · доставлено`}</small>;
  if (s.queued) return <small>{env.wide ? "в очереди · ✓" : "в очереди"}</small>;
  return <small>{env.wide ? `${at} · ✓` : `${at} · доставлено`}</small>;
}

function RewindCard({ uuid }: { uuid: string }) {
  const env = useEnv();
  const r = env.rewind;
  if (r?.uuid !== uuid) return null;
  return (
    <div className={`chat-rwc ${r.tone}`} role="status">
      <span>{r.text}</span>
      {r.ready ? (
        <>
          <Btn type="button" className="chat-mini" onClick={env.cancelRewind}>
            Отмена
          </Btn>
          <Btn bad type="button" className="chat-mini" onClick={() => env.applyRewind(uuid)}>
            Откатить
          </Btn>
        </>
      ) : null}
    </div>
  );
}

function Me({ row }: { row: Extract<Row, { k: "me" }> }) {
  const env = useEnv();
  const s = env.sends[row.uuid];
  const pics = s ? s.files.filter((f) => f.media_type.startsWith("image/")).map((f) => `data:${f.media_type};base64,${f.data}`) : row.pics;
  const others = s ? s.files.filter((f) => !f.media_type.startsWith("image/")) : [];
  const canRewind = env.wide && env.canCall && s?.state !== "lost" && s?.state !== "sending";
  const canCancel = env.canCall && s?.queued && s.state === "ok";
  return (
    <>
      <div className={s?.state === "lost" ? "chat-me pend" : "chat-me"} data-state={s?.state}>
        {pics.length ? (
          <div className="chat-pics">
            {pics.map((src, i) => (
              <a key={i} href={src} target="_blank" rel="noopener noreferrer">
                <img src={src} alt={`картинка ${i + 1}`} />
              </a>
            ))}
          </div>
        ) : null}
        {others.map((f, i) => (
          <span key={i} className="chat-att">
            <FileText size={13} />
            {f.name}
          </span>
        ))}
        {row.text}
        <Tail uuid={row.uuid} />
        {canCancel ? (
          <TextBtn className="chat-again chat-cancel" onClick={() => env.cancel(row.uuid)}>
            <Undo2 size={11} />
            отменить
          </TextBtn>
        ) : null}
        {canRewind ? (
          <TextBtn className="chat-rw" onClick={() => env.probeRewind(row.uuid)}>
            <History size={11} />
            откатить файлы
          </TextBtn>
        ) : null}
      </div>
      <RewindCard uuid={row.uuid} />
    </>
  );
}

/** Режим отправителя, о котором стоит сказать: обычный «Спрашивать» — нет; bypass — так его пишет claude у субагентов. */
const peerMode = (m: string) => (m === "default" ? undefined : permModeName(m === "bypass" ? "bypassPermissions" : m)?.toLowerCase());

/** Сообщение другой сессии или субагента. */
function Peer({ row }: { row: Extract<Row, { k: "in" }> }) {
  const agent = row.kind === "agent";
  const long = row.text.length > LONG;
  const [open, setOpen] = useState(!long);
  const mode = row.mode ? peerMode(row.mode) : undefined;
  return (
    <div className="chat-in fleet" data-from={row.kind}>
      <div className="chat-from">
        {agent ? <Bot size={13} /> : <MessagesSquare size={13} />}
        {`${agent ? "субагент" : "сессия Claude"}${row.name ? ` · ${row.name}` : ""}`}
        {mode ? <span className="chat-tag">{mode}</span> : null}
      </div>
      <div className={open ? "" : "chat-clamp"}>
        <Markdown text={row.text} />
      </div>
      {long ? (
        <DisclosureBtn open={open} className="chat-more" onClick={() => setOpen(!open)}>
          {open ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
          {open ? "свернуть" : "показать всё"}
        </DisclosureBtn>
      ) : null}
    </div>
  );
}

/** Сообщение сессии владельцу. */
function Owner({ row }: { row: Extract<Row, { k: "in" }> }) {
  const env = useEnv();
  return (
    <div className="chat-in">
      <div className="chat-from">
        {`${env.label(row.name ?? "")} → вам`}
        {row.push ? <span className="chat-tag">из уведомления</span> : null}
      </div>
      <Markdown text={row.text} />
      {row.at ? <small>{hhmm(row.at)}</small> : null}
    </div>
  );
}

function Summary({ row }: { row: Extract<Row, { k: "sum" }> }) {
  const label = `контекст сжат${row.pre !== undefined ? ` · ${kTokens(row.pre)}${row.post ? ` → ${kTokens(row.post)}` : ""}` : ""}`;
  if (row.summary === undefined)
    return (
      <div className="chat-sys">
        <Archive size={13} />
        {label}
      </div>
    );
  return (
    <Dis
      className="chat-sum"
      head={
        <>
          <Archive size={13} />
          {label}
        </>
      }
    >
      <Markdown text={row.summary} />
    </Dis>
  );
}

/** Плашка: красная или жёлтая. */
function Banner({ tone, icon, title, body, children }: { tone: "bad" | "wait"; icon: ReactNode; title: string; body?: string; children?: ReactNode }) {
  return (
    <div className={`chat-ban ${tone}`} role={tone === "bad" ? "alert" : undefined}>
      {icon}
      <div>
        <b>{title}</b>
        {body ? <p>{body}</p> : null}
        {children}
      </div>
    </div>
  );
}

const AREA: Record<string, string> = { cyber: "кибербезопасность", bio: "биология и химия", chem: "химия", weapons: "оружие", self_harm: "самоповреждение" };

function Refusal({ row }: { row: Extract<Row, { k: "refusal" }> }) {
  const env = useEnv();
  const from = modelName(row.from ?? "") || "Модель";
  const why = [row.category ? `Область: ${AREA[row.category] ?? row.category}` : null, row.text?.trim()].filter(Boolean).join(". ");
  const icon = <ShieldOff size={BIG} />;
  if (row.to) {
    const to = modelName(row.to);
    return <Banner tone="wait" icon={icon} title={`${from} отказалась — ответ переписан моделью ${to}`} body={[row.local ? "Только этот ответ: модель сессии прежняя." : `Дальше сессия идёт на ${to}.`, why].filter(Boolean).join(" ")} />;
  }
  const ask = row.ask;
  return (
    <Banner tone="bad" icon={icon} title={`${from} отказалась отвечать`} body={why || undefined}>
      {ask ? (
        <Btn type="button" className="chat-mini" onClick={() => env.fillText(ask)}>
          <Pencil size={12} />
          Изменить сообщение
        </Btn>
      ) : null}
    </Banner>
  );
}

function TaskLine({ row }: { row: Extract<Row, { k: "task" }> }) {
  const env = useEnv();
  const t = env.view.tasks[row.task];
  if (!t) return null;
  const icon = t.type === "local_agent" ? <Bot size={13} /> : <Terminal size={13} />;
  if (t.ended) {
    const { text, dim, tone } = taskEndText(t);
    return (
      <div className={`chat-line ${tone}`}>
        {icon}
        <span>
          {text}
          {dim ? <span className="chat-dim">{dim}</span> : null}
        </span>
      </div>
    );
  }
  return (
    <div className="chat-line run">
      {icon}
      <span>{[t.desc, t.summary].filter(Boolean).join(" · ")}</span>
      <em>{steps(t.uses ?? 0)}</em>
      {env.canCall ? (
        <Btn type="button" className="chat-mini" onClick={() => env.act("stopTask", [t.id])}>
          <Square size={11} />
          Стоп
        </Btn>
      ) : null}
    </div>
  );
}

const RowView = memo(function RowView({ row }: { row: Row }) {
  switch (row.k) {
    case "reply":
      return <Reply row={row} />;
    case "me":
      return <Me row={row} />;
    case "in":
      return row.kind === "owner" ? <Owner row={row} /> : <Peer row={row} />;
    case "cmd":
      // вывод без имени команды (смена модели на лету) — серой строкой
      if (!row.name)
        return (
          <div className="chat-line">
            <Zap size={13} />
            <span>{row.out}</span>
          </div>
        );
      return (
        <div className="chat-cmd">
          <span>
            <Zap size={12} />
            {row.args ? `${row.name} ${row.args}` : row.name}
          </span>
          {row.out ? <pre>{row.out}</pre> : null}
        </div>
      );
    case "sys":
      return (
        <div className={`chat-sys${row.tone ? ` ${row.tone}` : ""}`}>
          {ICONS[row.icon](13)}
          {row.text}
        </div>
      );
    case "sum":
      return <Summary row={row} />;
    case "res":
      return (
        <div className="chat-res">
          {row.bits.map((b, i) => (
            <span key={i}>
              {i ? " · " : null}
              <span className="chat-nb">{b}</span>
            </span>
          ))}
        </div>
      );
    case "end":
      return (
        <div className="chat-res err">
          <AlertTriangle size={13} />
          {row.text}
          {row.err ? <p>{row.err}</p> : null}
        </div>
      );
    case "line":
      return (
        <div className={row.tone ? `chat-line ${row.tone}` : "chat-line"}>
          {ICONS[row.icon](13)}
          <span>
            {row.text}
            {row.dim ? <span className="chat-dim">{row.dim}</span> : null}
          </span>
        </div>
      );
    case "task":
      return <TaskLine row={row} />;
    case "ban":
      return <Banner tone={row.tone} icon={ICONS[row.icon](BIG)} title={row.title} body={row.body} />;
    case "refusal":
      return <Refusal row={row} />;
  }
});

export function Rows({ rows }: { rows: readonly Row[] }) {
  return (
    <>
      {rows.map((r) => (
        <RowView key={r.id} row={r} />
      ))}
    </>
  );
}
