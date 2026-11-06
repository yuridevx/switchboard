// Строки ленты: свои и чужие сообщения, ответ Claude, служебные строки и плашки.
import { useState, type ReactNode } from "react";
import { Btn, CodeBlock, CopyButton, DisclosureBtn, hhmm, Markdown, permModeName, plural, TextBtn } from "@switchboard/web-ui";
import { taskIcon, type Part, type Row } from "../fold.ts";
import { TASK_END } from "../words.ts";
import { useEnv } from "./env.ts";
import { Icon } from "./icons.tsx";
import { ToolCard } from "./Tool.tsx";

const CLAMP_AT = 700;
const THINK_TAIL = 400;
const DOC = /^\s*(<!doctype html|<html[\s>])/i;

/** Свёрнутая строка: заголовок и тело по нажатию. */
export function Dis({ className, head, children }: { className?: string; head: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`dis ${className ?? ""}`.trim()}>
      <DisclosureBtn className="dis-h" open={open} onClick={() => setOpen(!open)}>
        {head}
        <Icon name={open ? "chevron-down" : "chevron-right"} size={14} />
      </DisclosureBtn>
      {open ? <div className="dis-b">{children}</div> : null}
    </div>
  );
}

function Text({ part }: { part: Extract<Part, { k: "text" }> }) {
  // целый документ: готовый — блок с просмотром, пишущийся — как текст
  if (!part.live && DOC.test(part.text)) return <CodeBlock code={part.text.trim()} lang="html" />;
  return (
    <div className="chat-txt">
      <Markdown text={part.text} live={part.live} />
    </div>
  );
}

function Think({ part }: { part: Extract<Part, { k: "think" }> }) {
  const label = (text: string) => (
    <>
      <Icon name="brain-circuit" size={14} />
      {text}
    </>
  );
  if (part.live)
    return (
      <div className="chat-think live">
        <div className="chat-think-h">{label("Размышляет…")}</div>
        <div className="chat-think-t">{part.text.slice(-THINK_TAIL)}</div>
      </div>
    );
  if (!part.text)
    return (
      <div className="chat-think">
        <div className="chat-think-h">{label("Размышлял")}</div>
      </div>
    );
  return (
    <Dis className="chat-think" head={label("Размышлял")}>
      <div className="chat-think-t">
        <Markdown text={part.text} />
      </div>
    </Dis>
  );
}

export function Reply({ parts }: { parts: Part[] }) {
  const texts = parts.flatMap((p) => (p.k === "text" ? [p] : []));
  const ready = texts.length > 0 && !texts.some((p) => p.live);
  return (
    <div className="chat-reply">
      {parts.map((p, i) => (p.k === "text" ? <Text key={i} part={p} /> : p.k === "think" ? <Think key={i} part={p} /> : <ToolCard key={p.id} id={p.id} />))}
      {ready ? (
        <div className="chat-acts">
          <CopyButton text={texts.map((p) => p.text).join("\n\n")} label="копировать" />
        </div>
      ) : null}
    </div>
  );
}

function Rewind({ id }: { id: string }) {
  const env = useEnv();
  const rw = env.rewind;
  if (rw?.id !== id) return null;
  return (
    <div className={`chat-rwc ${rw.state === "bad" || rw.state === "ok" ? rw.state : ""}`.trim()} role="status">
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

function Me({ r }: { r: Extract<Row, { k: "me" }> }) {
  const env = useEnv();
  const s = r.uuid ? env.sends[r.uuid] : undefined;
  const echoed = !!s && r.key !== `send:${s.uuid}`;
  const pics = [...r.pics, ...(s?.files ?? []).filter((f) => f.media_type.startsWith("image/")).map((f) => `data:${f.media_type};base64,${f.data}`)];
  const files = (s?.files ?? []).filter((f) => !f.media_type.startsWith("image/"));
  const state = s && (echoed ? "echo" : s.state);
  const lost = state === "lost";
  const stamp = () => {
    if (!s) return "";
    if (state === "sending") return "отправляю…";
    if (s.queued && state === "ok") return env.wide ? "в очереди · ✓" : "в очереди";
    return `${hhmm(s.at)} · ${env.wide ? (state === "echo" ? "✓✓" : "✓") : "доставлено"}`;
  };
  return (
    <>
      <div className={lost ? "chat-me pend" : "chat-me"} data-state={state === "echo" ? "ok" : state}>
        {pics.length ? (
          <div className="chat-pics">
            {pics.map((src, i) => (
              <a key={i} href={src} target="_blank" rel="noopener noreferrer">
                <img src={src} alt={`картинка ${i + 1}`} />
              </a>
            ))}
          </div>
        ) : null}
        {files.map((f, i) => (
          <span key={i} className="chat-att">
            <Icon name="file-text" size={12} />
            {f.name}
          </span>
        ))}
        {r.text}
        {lost ? (
          <small>
            {"связь оборвалась до ответа — "}
            <span className="chat-nb">не подтверждено ·</span>{" "}
            <TextBtn className="chat-again" onClick={() => env.again(s!.uuid)}>
              <Icon name="rotate-cw" size={11} />
              отправить ещё раз
            </TextBtn>
          </small>
        ) : stamp() ? (
          <small>{stamp()}</small>
        ) : null}
        {s?.queued && state === "ok" && env.canAct ? (
          <TextBtn className="chat-again chat-cancel" onClick={() => env.cancel(s.uuid)}>
            <Icon name="undo-2" size={11} />
            отменить
          </TextBtn>
        ) : null}
        {env.wide && env.canAct && r.uuid && (!s || state === "echo" || state === "ok") ? (
          <TextBtn className="chat-rw" onClick={() => env.probe(r.uuid!)}>
            <Icon name="history" size={11} />
            откатить файлы
          </TextBtn>
        ) : null}
      </div>
      {r.uuid ? <Rewind id={r.uuid} /> : null}
    </>
  );
}

function Incoming({ r }: { r: Extract<Row, { k: "in" }> }) {
  const env = useEnv();
  const owner = r.via === "owner";
  const long = !owner && r.text.length > CLAMP_AT;
  const [whole, setWhole] = useState(false);
  const from = owner ? `${env.label} → вам` : r.via === "agent" ? `субагент · ${r.from}` : r.from ? `сессия Claude · ${r.from}` : "сессия Claude";
  return (
    <div className={owner ? "chat-in" : "chat-in fleet"} data-from={owner ? undefined : r.via}>
      <div className="chat-from">
        {r.via === "agent" ? <Icon name="bot" /> : r.via === "session" ? <Icon name="messages-square" /> : null}
        {from}
        {r.tag ? <span className="chat-tag">{owner ? r.tag : (permModeName(r.tag)?.toLowerCase() ?? r.tag)}</span> : null}
      </div>
      {owner ? (
        <Markdown text={r.text} />
      ) : (
        <>
          <div className={long && !whole ? "chat-clamp" : ""}>
            <Markdown text={r.text} />
          </div>
          {long ? (
            <DisclosureBtn className="chat-more" open={whole} onClick={() => setWhole(!whole)}>
              <Icon name={whole ? "chevron-up" : "chevron-down"} />
              {whole ? "свернуть" : "показать всё"}
            </DisclosureBtn>
          ) : null}
        </>
      )}
      {r.at ? <small>{r.at}</small> : null}
    </div>
  );
}

function Banner({ r }: { r: Extract<Row, { k: "ban" }> }) {
  const env = useEnv();
  const { edit } = r;
  return (
    <div className={`chat-ban ${r.tone}`} {...(r.tone === "bad" ? { role: "alert" } : {})}>
      <Icon name={r.icon ?? (r.tone === "bad" ? "x" : "info")} size={15} />
      <div>
        <b>{r.title}</b>
        {r.body ? <p>{r.body}</p> : null}
        {edit !== undefined ? (
          <Btn type="button" className="chat-mini" onClick={() => env.fill(edit)}>
            <Icon name="pencil" size={12} />
            Изменить сообщение
          </Btn>
        ) : null}
      </div>
    </div>
  );
}

function RunningTask({ id }: { id: string }) {
  const env = useEnv();
  const t = env.view.tasks[id];
  if (!t) return null;
  const steps = t.steps ?? 0;
  return (
    <div className="chat-line run">
      <Icon name={taskIcon(t.type)} />
      <span>{[t.desc, t.summary].filter(Boolean).join(" · ")}</span>
      <em>{`${steps} ${plural(steps, "шаг", "шага", "шагов")}`}</em>
      {env.canAct ? (
        <Btn type="button" className="chat-mini" onClick={() => env.act("stopTask", [id])}>
          <Icon name="square" />
          Стоп
        </Btn>
      ) : null}
    </div>
  );
}

export function RowView({ r }: { r: Row }) {
  switch (r.k) {
    case "me":
      return <Me r={r} />;
    case "in":
      return <Incoming r={r} />;
    case "reply":
      return <Reply parts={r.parts} />;
    case "ban":
      return <Banner r={r} />;
    case "task":
      return <RunningTask id={r.id} />;
    case "cmd":
      return (
        <div className="chat-cmd">
          <span>
            <Icon name="zap" size={12} />
            {r.args ? `${r.name} ${r.args}` : r.name}
          </span>
          {r.out ? <pre>{r.out}</pre> : null}
        </div>
      );
    case "sys":
      return (
        <div className={r.tone ? `chat-sys ${r.tone}` : "chat-sys"}>
          <Icon name={r.icon} />
          {r.text}
        </div>
      );
    case "line":
      return (
        <div className={r.tone ? `chat-line ${r.tone}` : "chat-line"}>
          {r.icon ? <Icon name={r.icon} /> : null}
          <span>
            {r.text}
            {r.dim ? <span className="chat-dim">{r.dim}</span> : null}
          </span>
        </div>
      );
    case "res":
      return (
        <div className="chat-res">
          {r.bits.map((bit, i) => (
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
          <Icon name="triangle-alert" />
          {r.text}
          {r.why ? <p>{r.why}</p> : null}
        </div>
      );
    case "sum":
      return (
        <Dis
          className="chat-sum"
          head={
            <>
              <Icon name="archive" />
              {r.stats}
            </>
          }
        >
          <Markdown text={r.text} />
        </Dis>
      );
  }
}

export function Rows({ rows }: { rows: readonly Row[] }) {
  return rows.map((r) => <RowView key={r.key} r={r} />);
}
