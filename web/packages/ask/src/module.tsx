// Снесено: экран отвечает словом.
import type { AppPart } from "@switchboard/web-core";

export type Question = { question: string; kind: string };

export const createAsk: AppPart["module"] = () => ({
  screens: { ask: { label: "Вопрос", view: () => <p>снесено</p>, head: () => ({ title: "снесено" }) } },
  marks: { asked: () => undefined, "asked.tool": () => false },
});
