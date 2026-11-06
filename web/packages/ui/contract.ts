// Контракт web-ui — набор страницы: компоненты, форматы, стиль основания и тип App, который реализует ядро. Состояния не держит, ядра не знает; createStore — основа состояния модуля; Markdown — текст Claude и песочница HTML.
// Модуль пользуется им через "ui@web-ui" в uses. Основание UI_CSS ставит ядро, без области.
import json from "./module.json" with { type: "json" };
import css from "./src/ui.css";
import md from "./src/md/markdown.css";

export const UI_CSS: string = css + md;
export { Markdown } from "./src/md/Markdown.tsx";
export { CodeBlock } from "./src/md/CodeBlock.tsx";
export { HtmlFrame } from "./src/md/HtmlFrame.tsx";
export { CopyButton } from "./src/md/CopyButton.tsx";
export { langOfPath, useHighlighted } from "./src/md/highlight.tsx";
export * from "./src/parts.tsx";
export * from "./src/labels.ts";
export { edgeScroll, holdTouch, track } from "./src/press.ts";
export type { Axis, Gesture, Point } from "./src/press.ts";
export * from "./src/sessions.ts";
export { ago, at, day, duration, hhmm, midnight, plural } from "./src/time.ts";
export { personal } from "./src/personal.ts";
export type { Personal, Scope } from "./src/personal.ts";
export { AppCtx, useApp, useLoad, useMachineLoad, useModule, useNow, useOutcome } from "./src/hooks.ts";
export { machineAnswers, okOf, wordOf } from "./src/machines.ts";
export type { MachineAnswer, MachineAnswers } from "./src/machines.ts";
export { createStore } from "./src/store.ts";
export type { Store } from "./src/store.ts";
export type { App, ConnState, Ctx, Marks, Params, Result, Section, SlotProps } from "./src/app.ts";
export type { AccountInfo, AccountWindow, AccountsAnswer, JournalAnswer, JournalRecord, ModelInfo, ProfileInfo, ProfileRepo, ProfilesAnswer, SlotInfo } from "./src/answers.ts";

export const manifest = json;
export default {};
