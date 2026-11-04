// Малая часть экранов настроек: строка итога по ключу.
import { Outcome, useApp } from "@switchboard/web-ui";
import { useSettings } from "./store.ts";

/** Строка отказа или итога по ключу. */
export function NoteOf({ k }: { k: string }) {
  const app = useApp();
  const settings = useSettings();
  return <Outcome note={app.use(() => settings.get().notes[k])} />;
}
