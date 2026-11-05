// Гейт манифестов: один пакет для сборки монорепо, старта Host и старта веб-приложений.
export type { Manifest, ConfigKind } from "./src/gate.ts";
export { check, loadRepo, nameOf, order, ownerOf } from "./src/gate.ts";
