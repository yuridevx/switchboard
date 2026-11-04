// Снесено: экран отвечает словом до новой реализации.
import type { AppPart, Manifest } from "@switchboard/web-core";

import json from "./module.json" with { type: "json" };

declare module "@switchboard/web-ui" {
  interface Marks {
    asked(callsign: string): string | undefined;
    "asked.tool"(callsign: string, toolUseId: string): boolean;
  }
}

const Gone = () => "снесено";
export const createAsk: AppPart["module"] = () => ({
  screens: { ask: { label: "Вопрос", path: "ask", view: Gone, head: () => ({ title: "снесено" }) } },
});
export const manifest: Manifest = json;
export default createAsk;
