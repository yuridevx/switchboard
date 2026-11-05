// Гейт манифестов: набор модулей годен или назван отказ. Один пакет для монорепо, сборки в «Выпусках», старта Host и старта страницы.
export type { Manifest } from "./src/manifest.ts";
export { nameOf, order, ownerOf } from "./src/manifest.ts";
export { check } from "./src/check.ts";
export { loadRepo } from "./src/repo.ts";
