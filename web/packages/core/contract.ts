// Контракт web-core — ядро обоих веб-приложений (телефон и пульт).
// Модуль приложения пользуется ядром через "app@web-core" в uses и отсюда же берёт типы и мелочи вида.
//
// Запуск приложения (web/phone/src/main.ts, web/pult/src/main.ts):
//   startApp({ root, relayUrl: RELAY_URL, parts: [{ manifest, module }, …], wide: false });
// Ядро: гейт набора (у экрана, метки, принимаемого кадра и раздела хранилища — один модуль) →
// ключ флота (из адреса после # при установке, потом из хранилища; на iPhone вне «Домой» — экран установки) →
// start() модулей → link к relay (hello с ключом, roster) → экран из адреса.
// Маршрут: кадр — модулю, чей frames принимает его type; roster — всем с roster@relay в uses (on.roster).
// Отказ relay revoked / bad_key / contract_mismatch — экран с причиной, без переподключений;
// обрыв и gate_unavailable — полоса «Нет связи», переподключение с растущей паузой, пока экран виден.
// Ушли с экрана: начатые запросы доводятся до reply, stop() модулей в обратном порядке, close(1000).
//
// Модуль — default export его contract.ts, объект AppModule:
//   export default {
//     frames: { question: onQuestion },             // кадры по type (имена — из uses)
//     on: { roster: draw, link: (s) => … },          // roster и смена связи
//     screens: { ask: { label: "Вопрос", mount(el, params) { …; return { head, refresh, close }; } } },
//     marks: { asked: (callsign) => text },          // метки для других модулей
//     store: ["drafts"],                             // свои разделы хранилища
//     css: "…",                                      // свои стили
//     start(app) { … }, stop() { … },
//   } satisfies AppModule;
// Что даёт ядро — интерфейс App (app.request, app.open, app.provides, app.store, app.deliver, app.mark, …).
export type {
  App,
  AppModule,
  AppPart,
  ConnState,
  Ctx,
  Head,
  Manifest,
  Params,
  Platform,
  Result,
  Running,
  Screen,
  ScreenHandle,
  Section,
  StartOptions,
} from "./src/types.ts";
export type { Store } from "./src/store.ts";
export type { Frame, Roster, RosterMachine, SessionRecord } from "@switchboard/relay";

/** Запустить приложение. */
export { startApp, detectPlatform, keyId } from "./src/app.ts";
/** Гейт набора модулей выпуска (зовёт startApp; отдельно — для тестов выпуска). */
export { appGate, CORE } from "./src/gate.ts";
/** Хранилище разделов: IndexedDB (страница и обработчик пушей) и в памяти (стенд). */
export { idbStore, memoryStore } from "./src/store.ts";
/** Мелочи вида: построитель элементов, подписи состояний сессии, время, склонение. */
export { h, stateLabel, sessionLine, hhmm, duration, plural } from "./src/ui.ts";
export type { Tone } from "./src/ui.ts";
