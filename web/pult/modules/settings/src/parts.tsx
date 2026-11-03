// Малые части экранов настроек: строка итога по ключу и поле, чей текст переживает закрытие экрана.
import { useState, type ComponentProps } from "react";
import { useApp } from "@switchboard/web-core";
import { In, Outcome } from "@switchboard/web-ui";
import { useSettings } from "./context.ts";

/** Строка отказа или итога по ключу. */
export function NoteOf({ k }: { k: string }) {
  const app = useApp();
  const settings = useSettings();
  return <Outcome note={app.use(() => settings.get().notes[k])} />;
}

/**
 * Поле с текстом в хранилище: набор живёт здесь (хранилище обновляет вид на следующем такте, курсор при правке внутри текста не прыгает);
 * initial — текст при появлении поля.
 */
export function StoredIn({ initial, onValue, ...p }: Omit<ComponentProps<typeof In>, "value" | "defaultValue" | "onInput"> & { initial: string; onValue(v: string): void }) {
  const [text, setText] = useState(initial);
  return (
    <In
      {...p}
      value={text}
      onInput={(e) => {
        setText(e.currentTarget.value);
        onValue(e.currentTarget.value);
      }}
    />
  );
}
