// Сообщения людей и сессий: свой пузырь с доставкой, сообщение другой сессии или субагента, сообщение сессии владельцу.
import { useState } from "react";
import { Bot, ChevronDown, ChevronUp, FileText, History, MessagesSquare, RotateCw, Undo2 } from "lucide-react";
import { DisclosureBtn, hhmm, Markdown, permModeName, TextBtn } from "@switchboard/web-ui";
import { useCards } from "../context.ts";
import type { InItem, UserItem } from "../state/types.ts";

/** Режим отправителя, о котором стоит сказать: обычный «Спрашивать» — нет; bypass — так его пишет claude у субагентов. */
const peerMode = (m: string) => (m === "default" ? undefined : permModeName(m === "bypass" ? "bypassPermissions" : m)?.toLowerCase());
/** Длиннее — свёрнуто. */
const LONG = 700;

/** Подпись доставки: узко — словами, широко — галочками. */
function tailOf(it: UserItem, wide: boolean): string | null {
  if (!it.state) return null;
  const at = it.at ? hhmm(it.at) : "";
  if (it.state === "sending") return "отправляю…";
  if (it.state === "echo") return wide ? `${at} · ✓✓` : `${at} · доставлено`;
  if (it.queued) return wide ? "в очереди · ✓" : "в очереди";
  return wide ? `${at} · ✓` : `${at} · доставлено`;
}

export function MeCard({ it }: { it: UserItem }) {
  const v = useCards();
  const lost = it.state === "lost";
  const tail = tailOf(it, v.wide);
  const canRewind = v.rewind && it.state !== "lost" && it.state !== "sending";
  const canCancel = v.unqueue && it.queued && it.state === "ok";
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
          связь оборвалась до ответа — <span className="chat-nb">не подтверждено ·</span>{" "}
          <TextBtn className="chat-again" onClick={() => v.resend?.(it.id, it.text)}>
            <RotateCw size={11} />
            отправить ещё раз
          </TextBtn>
        </small>
      ) : tail ? (
        <small>{tail}</small>
      ) : null}
      {canCancel ? (
        <TextBtn className="chat-again chat-cancel" onClick={() => v.unqueue!(it.id, it.text)}>
          <Undo2 size={11} />
          отменить
        </TextBtn>
      ) : null}
      {canRewind ? (
        <TextBtn className="chat-rw" onClick={() => v.rewind!(it.id)}>
          <History size={11} />
          откатить файлы
        </TextBtn>
      ) : null}
    </div>
  );
}

export function PeerCard({ it }: { it: UserItem }) {
  const f = it.from!;
  const agent = f.kind === "agent";
  const long = it.text.length > LONG;
  const [open, setOpen] = useState(!long);
  const mode = f.mode ? peerMode(f.mode) : undefined;
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
        <DisclosureBtn open={open} className="chat-more" onClick={() => setOpen(!open)}>
          {open ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
          {open ? "свернуть" : "показать всё"}
        </DisclosureBtn>
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
