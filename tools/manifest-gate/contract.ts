// Гейт манифестов: один пакет для сборки монорепо, старта Host и старта веб-приложений.
export type { Manifest, ConfigKind } from "./src/check.ts";
export { check } from "./src/check.ts";
export { loadRepo } from "./src/repo.ts";
