// Гейт манифестов: набор модулей годен или назван отказ. Один пакет для монорепо, сборки в «Выпусках», старта Host и старта страницы.
export type { Manifest } from "./src/check.ts";
export { check, checkSet, nameOf, order, ownerOf } from "./src/check.ts";
export { loadRepo, TEST } from "./src/repo.ts";
