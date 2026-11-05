// Снесено: экран отвечает словом.
import type { AppPart } from "@switchboard/web-core";

export const createChat: AppPart["module"] = () => ({
  screens: { chat: { label: "Лента", view: () => <p>снесено</p>, head: () => ({ title: "снесено" }) } },
  marks: { unread: () => undefined, models: () => undefined },
  commands: { "models.load": { run: () => {} } },
  store: ["drafts"],
});
