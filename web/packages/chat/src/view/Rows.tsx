// Строки ленты: свои и чужие сообщения, ответ Claude, служебные строки и плашки.
import { useState, type ReactNode } from "react";
import { Btn, CodeBlock, CopyButton, DisclosureBtn, hhmm, Markdown, permModeName, TextBtn } from "@switchboard/web-ui";
import { RotateCcwClock, RotateCw } from "lucide-react";
import type { Part, Row } from "../fold.ts";
import { steps, taskEnd } from "../words.ts";
import { useEnv } from "./env.ts";
import { Icon } from "./icons.tsx";
import { ToolCard } from "./Tool.tsx";

const LONG = 700;
const cls = (...w: unknown[]) => w.filter(Boolean).join(" ");

/** Свёрнутая строка: заголовок и тело по нажатию. */
export function Dis({ className, head, open: start = false, children }: { className: string; head: ReactNode; open?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(start);
  return (
    <div className={`dis ${className}`}>
      <DisclosureBtn className="dis-h" open={open} onClick={() => setOpen(!open)}>
        {head}
        <Icon name="chevron-down" size={14} />
      </DisclosureBtn>
      {open && <div className="dis-b">{children}</div>}
    </div>
  );
}

function Think({ text, live, redacted }: { text: string; live?: boolean; redacted?: boolean }) {
  const head = (
    <span className="chat-think-h">
      <Icon name="brain-circuit" size={14} />
      {live ? "Размышляет…" : "Размышлял"}
    </span>
  );
  if (live)
    return (
      <div className="chat-think live">
        {head}
        <div className="chat-think-t">{text.slice(-400)}</div>
      </div>
    );
  if (redacted || !text.trim()) return <div className="chat-think">{head}</div>;
  return (
    <Dis className="chat-think" head={head}>
      <div className="chat-think-t">
        <Markdown text={text} />
      </div>
    </Dis>
  );
}

function PartView({ p }: { p: Part }) {
  if (p.k === "text")
    return (
      <div className="chat-txt">
        <Markdown text={p.text} />
      </div>
    );
  if (p.k === "doc") return <CodeBlock code={p.text} lang="html" />;
  if (p.k === "think") return <Think text={p.text} redacted={p.redacted} />;
  return <ToolCard id={p.id} />;
}

export function Reply({ r, only }: { r: Extract<Row, { k: "reply" }>; only?: Part[] }) {
  const parts = only ?? r.parts;
  const writing = !only && (r.liveText !== undefined || r.liveThink !== undefined);
  const texts = parts.filter((p) => p.k === "text").map((p) => (p as { text: string }).text);
  return (
    <div className="chat-reply">
      {parts.map((p, i) => (
        <PartView key={i} p={p} />
      ))}
      {!only && r.liveThink !== undefined && <Think text={r.liveThink} live />}
      {!only && r.liveText !== undefined && (
        <div className="chat-txt">
          <Markdown text={r.liveText} live />
        </div>
      )}
      {!writing && texts.length > 0 && (
        <div className="chat-acts">
          <CopyButton text={texts.join("\n\n")} label="" />
        </div>
      )}
    </div>
  );
}

function Me({ r }: { r: Extract<Row, { k: "me" }> }) {
  const env = useEnv();
  const s = r.uuid ? env.sends[r.uuid] : undefined;
  const echoed = !!s && r.key !== `send:${s.uuid}`;
  const pics = [...r.pics, ...(s?.files ?? []).filter((f) => f.media_type.startsWith("image/")).map((f) => `data:${f.media_type};base64,${f.data}`)];
  const files = (s?.files ?? []).filter((f) => !f.media_type.startsWith("image/"));
  const state = s ? (echoed ? "ok" : s.state === "queued" ? "ok" : s.state) : undefined;
  const time = s ? hhmm(s.at) : "";
  const status = !s
    ? null
    : echoed
      ? `${time} · ${env.wide ? "✓✓" : "доставлено"}`
      : s.state === "sending"
        ? "отправляю…"
        : s.state === "queued"
          ? env.wide ? "в очереди · ✓" : "в очереди"
          : s.state === "ok"
            ? `${time} · ${env.wide ? "✓" : "доставлено"}`
            : null;
  const rw = env.wide && env.canAct && !!r.uuid && (!s || echoed || s.state === "ok" || s.state === "queued");
  const rwState = r.uuid ? env.rewinds[r.uuid] : undefined;
  return (
    <>
      <div className={cls("chat-me", state === "pend" && "pend")} data-state={state}>
        {files.map((f) => (
          <span key={f.name} className="chat-att">
            {f.name}
          </span>
        ))}
        {pics.length > 0 && (
          <div className="chat-pics">
            {pics.map((src, i) => (
              <a key={i} href={src} target="_blank" rel="noopener">
                <img src={src} alt={`картинка ${i + 1}`} />
              </a>
            ))}
          </div>
        )}
        {r.text}
        {status !== null && <small>{status}</small>}
        {state === "pend" && (
          <small>
            {"связь оборвалась до ответа — "}
            <span className="chat-nb">не подтверждено ·</span>{" "}
            <TextBtn className="chat-again" onClick={() => env.again(s!.uuid)}>
              <RotateCw size={11} aria-hidden="true" />
              отправить ещё раз
            </TextBtn>
          </small>
        )}
        {s?.state === "queued" && !echoed && env.canAct && (
          <TextBtn className="chat-again chat-cancel" onClick={() => env.cancel(s.uuid)}>
            отменить
          </TextBtn>
        )}
        {rw && (
          <TextBtn className="chat-rw" onClick={() => env.rewind(r.uuid!, false)}>
            <RotateCcwClock size={12} aria-hidden="true" />
            откатить файлы
          </TextBtn>
        )}
      </div>
      {rwState && (
        <div className={cls("chat-rwc", rwState.state === "done" && "ok", (rwState.state === "no" || rwState.state === "bad") && "bad")} role={rwState.state === "no" || rwState.state === "bad" ? "alert" : "status"}>
          {rwState.state === "ask" ? (
            <>
              <span>{rwState.text}</span>
              <Btn className="chat-mini" onClick={() => env.dropRewind(r.uuid!)}>
                Отмена
              </Btn>
              <Btn className="chat-mini" onClick={() => env.rewind(r.uuid!, true)}>
                Откатить
              </Btn>
            </>
          ) : (
            rwState.text
          )}
        </div>
      )}
    </>
  );
}

function In({ r }: { r: Extract<Row, { k: "in" }> }) {
  const env = useEnv();
  const [all, setAll] = useState(false);
  if (r.from === "owner")
    return (
      <div className="chat-in">
        <div className="chat-from">
          {`${env.label} → вам`}
          {r.push && <span className="chat-tag">из уведомления</span>}
        </div>
        <Markdown text={r.text} />
        {r.at && <small>{hhmm(r.at)}</small>}
      </div>
    );
  const long = r.text.length > LONG && !all;
  const mode = r.mode && (permModeName(r.mode) ?? r.mode).toLowerCase();
  return (
    <div className="chat-in fleet" data-from={r.from}>
      <div className="chat-from">
        <Icon name={r.from === "agent" ? "bot" : "messages-square"} />
        {`${r.from === "agent" ? "субагент" : "сессия Claude"} · ${r.name}`}
        {mode && <span className="chat-tag">{mode}</span>}
      </div>
      {long ? (
        <>
          <div className="chat-clamp">
            <Markdown text={r.text} />
          </div>
          <DisclosureBtn className="chat-more" open={false} onClick={() => setAll(true)}>
            показать всё
          </DisclosureBtn>
        </>
      ) : (
        <Markdown text={r.text} />
      )}
    </div>
  );
}

function TaskRow({ id }: { id: string }) {
  const env = useEnv();
  const t = env.view.tasks[id];
  if (!t || t.status === "gone") return null;
  const icon = t.type === "local_bash" ? "terminal" : "bot";
  if (t.status !== "running") {
    const [word, tone] = taskEnd(t.status);
    const what = t.description || t.summary;
    return <Line r={{ k: "line", key: id, icon, text: word, tone, dim: what ? ` · ${what}` : undefined }} />;
  }
  return (
    <div className="chat-line run">
      <Icon name={icon} />
      <span>{[t.description || t.id, t.summary].filter(Boolean).join(" · ")}</span>
      <em>{steps(t.uses ?? 0)}</em>
      {env.canAct && (
        <Btn className="chat-mini" onClick={() => env.act("stopTask", [t.id])}>
          <Icon name="square" />
          Стоп
        </Btn>
      )}
    </div>
  );
}

function Line({ r }: { r: Extract<Row, { k: "line" }> }) {
  return (
    <div className={cls("chat-line", r.tone)}>
      {r.icon && <Icon name={r.icon} />}
      <span>
        {r.text}
        {r.dim && <span className="chat-dim">{r.dim}</span>}
      </span>
    </div>
  );
}

function Ban({ r }: { r: Extract<Row, { k: "ban" }> }) {
  const env = useEnv();
  const edit = r.edit ? env.view.rows.find((x) => x.k === "me" && x.uuid === r.edit) : undefined;
  return (
    <div className={`chat-ban ${r.tone}`} role={r.tone === "bad" ? "alert" : undefined}>
      <Icon name={r.icon} size={15} />
      <div>
        <b>{r.title}</b>
        {r.body && <p>{r.body}</p>}
        {r.edit && (
          <Btn className="chat-mini" onClick={() => env.fill(edit && edit.k === "me" ? edit.text : "")}>
            Изменить сообщение
          </Btn>
        )}
      </div>
    </div>
  );
}

export function RowView({ r }: { r: Row }) {
  switch (r.k) {
    case "me":
      return <Me r={r} />;
    case "in":
      return <In r={r} />;
    case "reply":
      return <Reply r={r} />;
    case "cmd":
      return (
        <div className="chat-cmd">
          <span>
            <Icon name="zap" size={12} />
            {r.name}
          </span>
          {r.out && <pre>{r.out}</pre>}
        </div>
      );
    case "sys":
      return (
        <div className={cls("chat-sys", r.tone)}>
          <Icon name={r.icon} />
          {r.text}
        </div>
      );
    case "line":
      return <Line r={r} />;
    case "task":
      return <TaskRow id={r.id} />;
    case "ban":
      return <Ban r={r} />;
    case "res":
      return r.err !== undefined ? (
        <div className="chat-res err">
          <Icon name="triangle-alert" />
          {`ход оборвался: ${r.err}`}
          {r.why && <p>{r.why}</p>}
        </div>
      ) : (
        <div className="chat-res">
          {r.parts.map((p, i) => (
            <span key={i}>
              {i ? " · " : ""}
              <span className="chat-nb">{p}</span>
            </span>
          ))}
        </div>
      );
    case "sum":
      return (
        <Dis
          className="chat-sum"
          head={
            <>
              <Icon name="archive" />
              {r.head}
            </>
          }
        >
          <Markdown text={r.text} />
        </Dis>
      );
  }
}

export function Rows({ rows }: { rows: readonly Row[] }) {
  return (
    <>
      {rows.map((r) => (
        <RowView key={r.key} r={r} />
      ))}
    </>
  );
}
