// Контракт web-ui — набор страницы: компоненты, форматы и стиль основания. Состояния не держит, ядра не знает; createStore — основа состояния модуля.
// Модуль пользуется им через "ui@web-ui" в uses. Основание UI_CSS ставит ядро, без области.
import json from "./module.json" with { type: "json" };
import css from "./src/ui.css";

export const UI_CSS: string = css;
export * from "./src/parts.tsx";
export * from "./src/format.ts";
export { personal } from "./src/personal.ts";
export { createStore } from "./src/store.ts";
export type { Store } from "./src/store.ts";
export type { Personal } from "./src/personal.ts";

export const manifest = json;
export default {};
