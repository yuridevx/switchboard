// Контракт web-party — настройки участника сессии: одна таблица у формы новой сессии и у настроек сессии (общий пакет телефона и пульта).
// PartyTable рисует ряды профиль, модель, слот, усилие; куда уходит выбор — решает вызывающий. Таблица живёт в месте вызывающего: стили PARTY_CSS он кладёт в свои, запрос profile.view идёт от его имени — в его uses он тоже есть.
import json from "./module.json" with { type: "json" };
import css from "./src/party.css";

export const PARTY_CSS: string = css;
export { PartyTable } from "./src/party.tsx";
export type { PartyData, PartySide, PartyValue } from "./src/party.tsx";
export const manifest = json;
export default {};
