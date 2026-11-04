// Подсказки поля ввода: «/» в начале — команды сессии, «@часть» в конце — файлы её папки.
// Стрелки выбирают, Tab и Enter подставляют, Esc закрывает до следующей правки текста. Что показать — считается из текста при рисовании.
import { useEffect, useState } from "react";
import { useApp, useLoad } from "@switchboard/web-ui";
import { useChat, useConv } from "../context.ts";

export type Suggestion = { key: string; label: string; hint?: string; insert: string };
export type Suggest = { kind: "cmd" | "file"; items: Suggestion[]; sel: number; move(d: 1 | -1): void; close(): void };

const AT = /(?:^|\s)@([^\s@]*)$/;
const SLASH = /^\/(\S*)$/;
const MAX = 20;
/** Вопрос сбоку — своя команда чата: в списке claude его нет. */
const BTW = { name: "btw", description: "вопрос сбоку: ответ по разговору, в разговор не попадёт" };
const NO_FILES = { ok: true as const, result: [] as string[] };

export function useSuggest(callsign: string, text: string): Suggest | null {
  const app = useApp();
  const chat = useChat();
  const canCall = app.use(() => chat.can(callsign, "session.call"));
  const canFiles = app.use(() => chat.can(callsign, "session.files"));
  const slash = canCall ? SLASH.exec(text)?.[1] : undefined;
  const at = canFiles && slash === undefined ? AT.exec(text)?.[1] : undefined;
  const commands = useConv(callsign, (c) => c.commands);
  const files = useLoad(() => (at === undefined ? Promise.resolve(NO_FILES) : chat.files(callsign, at)), [chat, callsign, at]);
  /** выбор и закрытие относятся к тексту, при котором сделаны: новая буква их сбрасывает */
  const [picked, setPicked] = useState({ text: "", sel: 0 });
  const [closedAt, setClosedAt] = useState<string | null>(null);

  const wantCommands = slash !== undefined;
  useEffect(() => {
    if (wantCommands) chat.loadCommands(callsign);
  }, [chat, callsign, wantCommands]);

  const kind: Suggest["kind"] = slash !== undefined ? "cmd" : "file";
  const items: Suggestion[] =
    slash !== undefined
      ? [...(commands ?? []), BTW]
          .filter((c) => c.name.startsWith(slash))
          .slice(0, MAX)
          .map((c) => ({ key: c.name, label: `/${c.name}`, hint: c.description, insert: `/${c.name} ` }))
      : at !== undefined && !files.error
        ? (files.data ?? []).map((f) => ({ key: f, label: f, insert: text.replace(/@([^\s@]*)$/, `@${f} `) }))
        : [];

  if (!items.length || closedAt === text) return null;
  const sel = Math.min(picked.text === text ? picked.sel : 0, items.length - 1);
  return {
    kind,
    items,
    sel,
    move: (d) => setPicked({ text, sel: (sel + d + items.length) % items.length }),
    close: () => setClosedAt(text),
  };
}
