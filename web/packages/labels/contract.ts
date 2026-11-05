// Снесено: экран и метки отвечают словом, пока не написаны новые.
import type { AppPart, Manifest } from "@switchboard/web-core";
import json from "./module.json" with { type: "json" };

export type Shown = { text: string; human: boolean };

declare module "@switchboard/web-ui" {
  interface Marks {
    "label.session"(callsign: string): Shown;
    "label.machine"(machine: string): Shown;
  }
}

const gone = (): Shown => ({ text: "снесено", human: false });
export const createLabels: AppPart["module"] = () => ({
  screens: { labels: { label: "Имена", path: "labels", view: () => null } },
  marks: { "label.session": gone, "label.machine": gone },
});
export const manifest: Manifest = json;
export default createLabels;
