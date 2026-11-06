// Bot API: всё, что знает о Telegram, кроме разбора обновлений. Поменять мессенджер — поменять этот файл.
import { CALL_MS } from "@switchboard/protocol";
import type { RoomsWord } from "../contract.ts";

export type Answer<T = Record<string, unknown>> = { ok: boolean; result?: T; error_code?: number; description?: string; parameters?: { retry_after?: number } };

async function bot<T>(token: string, method: string, body: unknown): Promise<Answer<T>> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(CALL_MS) });
    return (await res.json()) as Answer<T>;
  } catch (e) {
    return { ok: false, description: `Telegram не ответил: ${e}` };
  }
}

export const threadGone = (a: Answer<unknown>) => /thread not found/i.test(a.description ?? "");

/** Отказ Telegram словом и подсказкой модели. */
export function refusal(a: Answer<unknown>): { word: RoomsWord; why: string } {
  const text = a.description ?? "";
  if (a.error_code === 429) return { word: "rate_limited", why: `предел Telegram, повторить через ${a.parameters?.retry_after ?? "?"} с` };
  if (a.error_code === 403) return { word: "gone", why: `бота нет в чате: ${text}` };
  if (a.error_code === 413 || /too long/i.test(text)) return { word: "too_long", why: "текст больше предела Telegram: сократи" };
  if (threadGone(a)) return { word: "gone", why: "человек удалил тему: следующее сообщение создаст новую" };
  if (/not a forum|not enough rights/i.test(text)) return { word: "no_topics", why: `включите темы в группе и дайте боту право управлять ими: ${text}` };
  return { word: "send_failed", why: text };
}

export const newTopic = (token: string, chat: number, name: string) => bot<{ message_thread_id: number }>(token, "createForumTopic", { chat_id: chat, name });

/** Markdown модели уходит как есть: Telegram сам разбирает его в rich-сообщении. */
export const post = (token: string, chat: number, thread: number, markdown: string, silent: boolean, buttons: string[]) =>
  bot<{ message_id: number }>(token, "sendRichMessage", {
    chat_id: chat,
    message_thread_id: thread,
    rich_message: { markdown },
    disable_notification: silent,
    ...(buttons.length ? { reply_markup: { inline_keyboard: buttons.map((text, i) => [{ text, callback_data: String(i) }]) } } : {}),
  });

export const say = (token: string, chat: number, text: string) => bot(token, "sendMessage", { chat_id: chat, text });

export const react = (token: string, chat: number, message: number, emoji: string) => bot(token, "setMessageReaction", { chat_id: chat, message_id: message, reaction: [{ type: "emoji", emoji }] });

export const ackButton = (token: string, id: string, text?: string) => bot(token, "answerCallbackQuery", { callback_query_id: id, ...(text ? { text } : {}) });

export const dropButtons = (token: string, chat: number, message: number) => bot(token, "editMessageReplyMarkup", { chat_id: chat, message_id: message });

export const hook = (token: string, url: string, secret: string) => bot(token, "setWebhook", { url, secret_token: secret, allowed_updates: ["message", "callback_query"], drop_pending_updates: true });
