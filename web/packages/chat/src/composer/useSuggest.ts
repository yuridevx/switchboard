// Подсказки поля ввода: «/» в начале — команды сессии, «@часть» в конце — файлы её папки.
// Стрелки выбирают, Tab и Enter подставляют, Esc закрывает до следующей правки текста.
import { useEffect, useState } from "react";
import { useChat } from "../context.ts";

export type Suggestion = { key: string; label: string; hint?: string; insert: string };
export type Suggest = { kind: "cmd" | "file"; items: Suggestion[]; sel: number; move(d: 1 | -1): void; close(): void };

const AT = /(?:^|\s)@([^\s@]*)$/;
const SLASH = /^\/(\S*)$/;
const MAX = 20;

export function useSuggest(callsign: string, text: string): Suggest | null {
  const chat = useChat();
  const canCall = chat.can(callsign, "session.call");
  const canFiles = chat.can(callsign, "session.files");
  const [items, setItems] = useState<Suggestion[]>([]);
  const [kind, setKind] = useState<Suggest["kind"]>("cmd");
  const [sel, setSel] = useState(0);
  const [closedAt, setClosedAt] = useState<string | null>(null);

  const slash = canCall ? SLASH.exec(text)?.[1] : undefined;
  const at = canFiles && slash === undefined ? AT.exec(text)?.[1] : undefined;

  useEffect(() => {
    setSel(0);
    if (slash === undefined && at === undefined) return setItems([]);
    let stale = false;
    const done = (k: Suggest["kind"], list: Suggestion[]) => {
      if (stale) return;
      setKind(k);
      setItems(list);
    };
    if (slash !== undefined) {
      void chat.commands(callsign).then((all) =>
        done(
          "cmd",
          all
            .filter((c) => c.name.startsWith(slash))
            .slice(0, MAX)
            .map((c) => ({ key: c.name, label: `/${c.name}`, hint: c.description, insert: `/${c.name} ` })),
        ),
      );
    } else if (at !== undefined) {
      void chat.files(callsign, at).then((all) => done("file", all.map((f) => ({ key: f, label: f, insert: text.replace(/@([^\s@]*)$/, `@${f} `) }))));
    }
    return () => {
      stale = true;
    };
  }, [chat, callsign, slash, at, text]);

  if (!items.length || closedAt === text) return null;
  return {
    kind,
    items,
    sel: Math.min(sel, items.length - 1),
    move: (d) => setSel((sel + d + items.length) % items.length),
    close: () => setClosedAt(text),
  };
}
