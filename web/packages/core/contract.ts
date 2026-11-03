// Контракт web-core — ядро обоих веб-приложений (телефон и пульт).
// Модуль приложения пользуется ядром через "app@web-core" в uses и отсюда же берёт типы и мелочи вида.
//
// Запуск сборки (оболочки web/phone и web/pult): startBuild({ root, build, wide, sections, beside }) — модули по списку
// build.json («@switchboard/<имя>» через import map сборки → m/<имя>.<версия>.js), адреса relay и Worker'ов — из него же;
// модуль не загрузился — выключен только он. Стенд и тесты зовут startApp({ root, workers, parts }) сами; relay — workers.relay.
// Файл модуля сборки — default (объект модуля) и manifest его contract.ts.
// Ядро: гейт набора (у экрана, метки, принимаемого кадра и раздела хранилища — один модуль) →
// ключ флота (из адреса после # при установке, потом из хранилища; на iPhone вне «Домой» — экран установки) →
// start() модулей → link к relay (hello с ключом, roster) → экран из адреса.
// Маршрут: кадр — модулю, чей frames принимает его type; roster — всем с roster@relay в uses (on.roster).
// Отказ relay revoked / bad_key / contract_mismatch — экран с причиной, без переподключений;
// обрыв и gate_unavailable — полоса «Нет связи», переподключение с растущей паузой, пока экран виден.
// Ушли с экрана: начатые запросы доводятся до reply, stop() модулей в обратном порядке, close(1000).
// Широкий вид (пульт, wide: true): колонка разделов с машинами на связи и именем устройства, без шапки;
// beside: { card: "board" } — экран открывается справа от списка, список остаётся слева в месте sb-master;
// app.current() — экран и параметры справа (строку списка подсвечивает сам список).
//
// Модуль — default export его contract.ts, объект AppModule:
//   export default {
//     frames: { question: onQuestion },             // кадры по type (имена — из uses)
//     on: { roster: draw, link: (s) => …, current: (c) => … }, // roster, смена связи, открытый экран
//     screens: { ask: { label: "Вопрос", view: Ask, head: (params) => ({ title: "Вопрос" }) } },
//     marks: { asked: (callsign) => text },          // метки для других модулей
//     store: ["drafts"],                             // свои разделы хранилища
//     css,                                           // свои стили: текст своего .css, ядро ограничивает его местом модуля
//     start(app) { … }, stop() { … },
//   } satisfies AppModule;
// Что даёт ядро — интерфейс App (app.request, app.open, app.can, app.store, app.deliver, app.mark, app.use, app.Slot, …).
// Вид: модуль получает app в start и рисует компоненты; app.use(select) — выборка, компонент перерисуется, когда изменился ответ;
// app.Slot — чужой экран в своём; ядро модуль не импортирует, отсюда — типы и useApp(): app модуля в компонентах его экрана.
export type {
  App,
  AppModule,
  BuildList,
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
  ScreenProps,
  SlotProps,
  Marks,
  Section,
  StartOptions,
} from "./src/types.ts";
export type { Store } from "./src/store.ts";
export type { Frame, Roster, RosterMachine, SessionRecord } from "@switchboard/relay";

/** App модуля в компонентах его экрана. */
export { useApp } from "./src/view/context.ts";
/** Запустить приложение. */
export { startApp, detectPlatform, keyId } from "./src/app.tsx";
/** Запустить сборку страницы по build.json. */
export { startBuild, LOAD_MS } from "./src/build.ts";
export type { BuildOptions } from "./src/build.ts";
/** Гейт набора модулей выпуска (зовёт startApp; отдельно — для тестов выпуска). */
export { appGate, CORE } from "./src/gate.ts";
/** Хранилище разделов: IndexedDB (страница и обработчик пушей) и в памяти (стенд). */
export { idbStore, memoryStore } from "./src/store.ts";
