// Сообщения людей и сессий: свой пузырь с доставкой, сообщение другой сессии или субагента, сообщение сессии владельцу.
import { useState } from "react";
import { Bot, ChevronDown, ChevronUp, FileText, History, MessagesSquare, RotateCw } from "lucide-react";
import { hhmm } from "@switchboard/web-ui";
import { useCards } from "../context.ts";
import type { InItem, UserItem } from "../state/types.ts";
import { Markdown } from "../ui/Markdown.tsx";

/** Режимы отправителя, о которых стоит сказать. */
const MODE: Record<string, string> = { bypass: "без вопросов", bypassPermissions: "без вопросов", plan: "план", acceptEdits: "правки сами", auto: "авто" };
/** Длиннее — свёрнуто. */
const LONG = 700;

/** Подпись доставки: узко — словами, широко — галочками. */
function tailOf(it: UserItem, wide: boolean): string | null {
  if (!it.state) return null;
  const at = it.at ? hhmm(it.at) : "";
  if (it.state === "sending") return "отправляю…";
  if (!wide) return `${at} · доставлено`;
  if (it.state === "echo") return `${at} · ✓✓`;
  return it.queued ? "в очереди · ✓" : `${at} · ✓`;
}

export function MeCard({ it }: { it: UserItem }) {
  const v = useCards();
  const lost = it.state === "lost";
  const tail = tailOf(it, v.wide);
  const canRewind = v.rewind && it.state !== "lost" && it.state !== "sending";
  return (
    <div className={lost ? "chat-me pend" : "chat-me"} data-state={it.state}>
      {it.images.length ? (
        <div className="chat-pics">
          {it.images.map((u, i) => (
            <a key={i} href={u} target="_blank" rel="noopener noreferrer">
              <img src={u} alt={`картинка ${i + 1}`} />
            </a>
          ))}
        </div>
      ) : null}
      {it.files.map((f, i) => (
        <span key={i} className="chat-att">
          <FileText size={13} />
          {f}
        </span>
      ))}
      {it.text}
      {lost ? (
        <small>
          связь оборвалась до ответа — не подтверждено ·{" "}
          <button type="button" className="chat-again" onClick={() => v.resend?.(it.id, it.text)}>
            <RotateCw size={11} />
            отправить ещё раз
          </button>
        </small>
      ) : tail ? (
        <small>{tail}</small>
      ) : null}
      {canRewind ? (
        <button type="button" className="chat-rw" onClick={() => v.rewind!(it.id)}>
          <History size={11} />
          откатить файлы
        </button>
      ) : null}
    </div>
  );
}

export function PeerCard({ it }: { it: UserItem }) {
  const f = it.from!;
  const agent = f.kind === "agent";
  const long = it.text.length > LONG;
  const [open, setOpen] = useState(!long);
  const mode = f.mode ? MODE[f.mode] : undefined;
  return (
    <div className="chat-in fleet" data-from={f.kind}>
      <div className="chat-from">
        {agent ? <Bot size={13} /> : <MessagesSquare size={13} />}
        {`${agent ? "субагент" : "сессия Claude"}${f.name ? ` · ${f.name}` : ""}`}
        {mode ? <span className="chat-tag">{mode}</span> : null}
      </div>
      <div className={open ? "" : "chat-clamp"}>
        <Markdown text={it.text} />
      </div>
      {long ? (
        <button type="button" className="chat-more" onClick={() => setOpen(!open)}>
          {open ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
          {open ? "свернуть" : "показать всё"}
        </button>
      ) : null}
    </div>
  );
}

export function InCard({ it }: { it: InItem }) {
  const { name } = useCards();
  return (
    <div className="chat-in">
      <div className="chat-from">
        {`${name} → вам`}
        {it.push ? <span className="chat-tag">из уведомления</span> : null}
      </div>
      <Markdown text={it.text} />
      <small>{hhmm(it.at)}</small>
    </div>
  );
}
