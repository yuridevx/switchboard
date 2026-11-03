// Разбор текста сообщений claude: чистые функции без состояния. Какие обёртки что значат — знает только этот файл.
import type { Peer } from "./types.ts";
import type { WireBlock, WireContent, WireMessage } from "./wire.ts";

export const textOf = (c?: WireContent): string =>
  typeof c === "string"
    ? c
    : Array.isArray(c)
      ? c
          .filter((b) => b?.type === "text")
          .map((b) => b.text ?? "")
          .join("\n")
      : "";

export const contentOf = (m: WireMessage): WireContent | undefined => (typeof m.message === "object" && m.message ? m.message.content : undefined);

/** Блок картинки → data: адрес; обрезанная или не base64 — пусто. */
export function imageUrl(b: WireBlock): string {
  const s = b.source;
  return s?.type === "base64" && typeof s.data === "string" && !s.data.includes("…") ? `data:${s.media_type};base64,${s.data}` : "";
}

/** Вывод инструмента: текст и картинки отдельно. */
export function resultOf(c: unknown): { text: string; images: string[] } {
  if (typeof c === "string") return { text: c, images: [] };
  if (!Array.isArray(c)) return { text: c == null ? "" : JSON.stringify(c), images: [] };
  const blocks = c as WireBlock[];
  return {
    text: blocks
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("\n"),
    images: blocks
      .filter((b) => b.type === "image")
      .map(imageUrl)
      .filter(Boolean),
  };
}

/** Тег сообщения другой сессии флота во вводе. */
const FLEET = /^<fleet-message from="([^"]+)">\n?([\s\S]*?)\n?<\/fleet-message>$/;
/** Обёртки claude у сообщений другой сессии и субагента, пришедших посреди хода. */
const WRAP = /^<(cross-session-message|agent-message)\b([^>]*)>\n?([\s\S]*?)\n?<\/\1>\s*$/;
const PEER = /^Another Claude session sent a message(?: while you were working)?:\n([\s\S]*?)(?:\n\nThis came from another Claude session|$)/;
const attr = (s: string, k: string) => new RegExp(`${k}="([^"]*)"`).exec(s)?.[1];

/** Сообщение не от человека: { text, from } или null. */
export function peerOf(raw: string, origin: WireMessage["origin"]): { text: string; from: Peer } | null {
  const fl = FLEET.exec(raw);
  if (fl) return { text: fl[2], from: { kind: "session", name: fl[1] } };
  if (origin?.kind !== "peer" && !WRAP.test(raw) && !PEER.test(raw)) return null;
  const inner = (PEER.exec(raw)?.[1] ?? raw).trim();
  const w = WRAP.exec(inner);
  return {
    text: (origin?.body || (w ? w[3] : inner)).trim(),
    from: {
      kind: origin?.senderTaskId || w?.[1] === "agent-message" ? "agent" : "session",
      name: origin?.name || (w && attr(w[2], "from-name")) || undefined,
      mode: origin?.fromMode || (w && attr(w[2], "from-mode")) || undefined,
    },
  };
}

const SUMMARY = /^This session is being continued from a previous conversation/;
export const isSummary = (m: WireMessage, raw: string) => !!m.isCompactSummary || (!m.parent_tool_use_id && SUMMARY.test(raw));

/** Текст сводки сжатия без обёртки claude: служебные вставки, вступление и хвост «продолжай». */
export function summaryOf(t: string): string {
  const s = t.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "");
  const from = s.search(/^Summary:\s*$/m);
  const body = from >= 0 ? s.slice(from).replace(/^Summary:\s*/, "") : s.replace(SUMMARY, "").replace(/^[^\n]*\n?/, "");
  return body.replace(/\n(If you need specific details from before compaction|Continue the conversation from where it left off)[\s\S]*$/, "").trim();
}

const tag = (s: string, t: string) => new RegExp(`<${t}>([\\s\\S]*?)</${t}>`).exec(s)?.[1];

/** Служебный текст «пользователя»: что это, если не реплика человека. */
export type Special =
  | { kind: "interrupted" }
  | { kind: "command"; name: string; args?: string }
  | { kind: "output"; text: string }
  | { kind: "task"; id?: string; status?: string; summary?: string }
  | { kind: "hidden" };

export function specialOf(text: string): Special | null {
  if (text.startsWith("[Request interrupted")) return { kind: "interrupted" };
  if (text.startsWith("<task-notification>")) return { kind: "task", id: tag(text, "task-id"), status: tag(text, "status"), summary: tag(text, "summary") };
  const cmd = /^<command-name>\/?([^<]+)<\/command-name>/.exec(text) ?? /^<command-message>\/?([^<]+)<\/command-message>/.exec(text);
  if (cmd) return { kind: "command", name: `/${cmd[1]}`, args: tag(text, "command-args")?.trim() || undefined };
  const out = /^<local-command-stdout>([\s\S]*)<\/local-command-stdout>/.exec(text);
  if (out) return { kind: "output", text: out[1].trim() };
  if (text.startsWith("<local-command") || text.startsWith("Caveat:") || text.startsWith("<system-reminder>")) return { kind: "hidden" };
  return null;
}

/** Полный HTML-документ, а не разметка с тегами: показывается отдельной страницей. */
export const isHtmlDocument = (t: string) => /^\s*(<!doctype html|<html[\s>])/i.test(t);
