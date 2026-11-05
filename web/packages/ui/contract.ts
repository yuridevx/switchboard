// Контракт web-ui снесён: дальше — новое устройство.
import json from "./module.json" with { type: "json" };
import css from "./src/ui.css";
import md from "./src/md/markdown.css";

export const UI_CSS: string = css + md;
export * from "./src/stub.ts";
export type { Result, App, ConnState, Ctx, Marks, Params, Section, SlotProps } from "./src/app.ts";
export type { AccountInfo, AccountWindow, AccountsAnswer, JournalAnswer, JournalRecord, ModelInfo, ProfileInfo, ProfileRepo, ProfilesAnswer, SlotInfo } from "./src/answers.ts";

export const manifest = json;
export default {};
