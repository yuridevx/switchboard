// Гейт манифестов: один пакет для сборки монорепо, старта Host и старта веб-приложений.
export type { ConfigKind, Manifest } from "./src/manifest.ts";
export { nameOf, ownerOf } from "./src/manifest.ts";
export { order } from "./src/graph.ts";
export { check } from "./src/check.ts";
export { loadRepo } from "./src/repo.ts";
