// Договор модуля веб-приложения: что модуль отдаёт ядру и что ядро даёт модулю.
import type { Frame, Roster } from "@switchboard/relay";
import type { Store } from "./store.ts";

/** module.json модуля приложения. provides — экраны и метки; uses — "имя@владелец": версия. */
export type Manifest = {
  name: string;
  type: string;
  version: string;
  provides: Record<string, number>;
  uses: Record<string, number>;
  config?: Record<string, "secret" | "var" | "binding">;
};

/** Параметры экрана — пары в адресе после #: #card?callsign=site%40laptop. */
export type Params = Record<string, string>;

/** Как пришёл кадр: open — пользователь нажал уведомление с этим кадром, владелец открывает свой экран. */
export type Ctx = { open: boolean };

/** Состояние связи для модулей и шапки. */
export type ConnState = "connecting" | "open" | "closed" | "stopped";

/** Шапка экрана, когда он открыт на весь экран. */
export type Head = {
  title: string;
  sub?: string;
  /** пилюля справа; пока нет связи, ядро ставит вместо неё свою */
  pill?: { text: string; tone?: "ok" | "wait" | "bad" | "busy" | "" };
  /** заголовок моноширинным — позывной */
  mono?: boolean;
};

/** То, что вернул mount экрана. */
export interface ScreenHandle {
  /** шапка экрана на весь экран; у экрана в месте не спрашивается */
  head?(): Head;
  /** перерисовать: ядро зовёт после roster, после changed() любого модуля и смены связи */
  refresh?(): void;
  /** экран убран со страницы */
  close?(): void;
}

/** Экран модуля. Имя экрана — ключ в screens и имя в provides модуля. */
export type Screen = {
  /** раздел навигации: на телефоне — шапка, в пульте — колонка слева; первый раздел — домашний */
  nav?: string;
  /** метка-счётчик раздела — имя из marks этого модуля, число */
  mark?: string;
  /**
   * Место, куда экран встаёт: «top» — полоса ядра над экранами разделов («Включить уведомления»); другое имя — место
   * модуля-владельца внутри его экрана (card.tab — вкладка карточки). Имя места — в uses модуля: top@web-core, card.tab@web-card.
   */
  place?: string;
  /** видна ли вставка с этими параметрами (вкладка — этой сессии); зовёт владелец места через app.placed */
  show?(params: Params): boolean;
  /** путь в адресе после #; по умолчанию — имя экрана */
  path?: string;
  /** человеческое имя: подпись вставки в месте (вкладка «Точки») и экран упавшего модуля — «Лента выключена» */
  label?: string;
  /** нарисовать экран в el; params — из адреса или из app.open */
  mount(el: HTMLElement, params: Params): ScreenHandle | void;
};

/**
 * Модуль приложения — default export его contract.ts. Все поля необязательны.
 * Ловушка ошибок: каждый вызов модуля ядро оборачивает. Бросил — модуль выключен до перезапуска
 * приложения: его кадры дальше не идут, метки пусты, на его экранах — причина. Остальные работают.
 */
export interface AppModule {
  /** Кадры по type — их имена должны быть в uses модуля (имя@владелец). У кадра один принимающий модуль. */
  frames?: Record<string, (f: Frame, ctx: Ctx) => void>;
  on?: {
    /** roster от relay — модулям, у которых roster@relay в uses */
    roster?(r: Roster): void;
    /** смена связи; open — hello принят: открытые экраны заново шлют свои подписки */
    link?(state: ConnState): void;
  };
  /** Экраны — имена из provides. */
  screens?: Record<string, Screen>;
  /** Метки для других модулей (asked, unread, need) — имена из provides. */
  marks?: Record<string, (...args: string[]) => unknown>;
  /** Разделы хранилища модуля; у раздела один владелец, key — раздел ядра. */
  store?: string[];
  /** Стили модуля — ядро кладёт их в <style> страницы. */
  css?: string;
  /** Поднять своё: ядро зовёт по порядку списка при старте и при возвращении на экран. */
  start?(app: App): void | Promise<void>;
  /** Штатная остановка при уходе с экрана: дописать хранилище, снять подписки. Порядок обратный. */
  stop?(): void | Promise<void>;
}

/** Ответ на запрос: результат или слово ошибки (offline, disconnected, already_answered, …). */
export type Result<T = unknown> = { ok: true; result: T } | { ok: false; error: string };

/** Раздел хранилища модуля. */
export interface Section<T> {
  get(): Promise<T | undefined>;
  set(value: T): Promise<void>;
  update(fn: (old: T | undefined) => T): Promise<T>;
}

/** Что ядро даёт модулю. У каждого модуля свой объект: ядро знает, кто зовёт. */
export interface App {
  /** имя клиента во флоте — из ключа: client.phone.k2a9… → phone */
  readonly name: string;
  /** широкий вид (пульт): экраны в местах; узкий (телефон): каждый экран на весь экран */
  readonly wide: boolean;
  /**
   * Запрос к Host или Worker-модулю: app.request("answer", { callsign, question, answers }).
   * Имя — только из uses модуля (иначе ошибка модуля); v ставит ядро из uses.
   * Владелец имени — Worker-модуль из roster (push) → to: .владелец; иначе адрес — callsign или machine кадра,
   * и ядро сверяет имя с contract машины в roster: нет — unknown_request, другая версия — contract_mismatch.
   * Не бросает: отказ — { ok: false, error }. Связи нет — disconnected сразу.
   */
  request<T = unknown>(name: string, body?: Record<string, unknown>): Promise<Result<T>>;
  /**
   * Открыть экран. Без place — на весь экран, с переходом в адресе; с place — внутри элемента
   * другого модуля (чат в карточке), тогда вернётся handle: его close() убирает экран.
   * Экран — свой, из uses модуля или вставленный в место, которым модуль владеет.
   */
  open(screen: string, params?: Params, place?: HTMLElement): ScreenHandle | undefined;
  /**
   * Экраны, вставленные в место модуля: имя места — из его provides (card.tab). Открыть вставку — app.open(screen, params, el).
   * show обёрнут ловушкой ошибок владельца экрана: бросил — его модуль выключен, вставка не видна.
   */
  placed(place: string): Array<{ screen: string; label: string; show(params: Params): boolean }>;
  /** Назад: на прошлый экран или на домашний раздел. */
  back(): void;
  /** Что умеет машина: её contract из последнего roster; машины нет в roster — null. */
  provides(machine: string): Record<string, number> | null;
  /** Последний roster; ядро держит его в памяти. */
  roster(): Roster | null;
  /** Есть ли во флоте Worker с этим именем — по списку адресов сборки, а не по roster. */
  worker(name: string): boolean;
  /** Экран на весь экран сейчас и его параметры (в широком виде — правая часть); до первого roster — null. */
  current(): { screen: string; params: Params } | null;
  /** Связь сейчас. */
  link(): ConnState;
  /** Метка другого модуля из uses: app.mark("asked", "profiles@laptop"). Выключенный владелец — undefined. */
  mark(name: string, ...args: string[]): unknown;
  /** Свой раздел хранилища (из store модуля). */
  store<T = unknown>(section: string): Section<T>;
  /** Кадр — модулю-владельцу его type, как пришедший с relay. */
  deliver(frame: Frame, ctx?: Ctx): void;
  /** Метки или данные модуля изменились — ядро перерисует открытые экраны. */
  changed(): void;
  /** Короткая строка внизу экрана: отказ, который надо увидеть. */
  toast(text: string, tone?: "ok" | "bad"): void;
}

/** Модуль выпуска: манифест и объект. */
export type AppPart = { manifest: Manifest; module: AppModule };

/** Список сборки страницы — build.json рядом со страницей; формат — у владельца формата выпуска. */
export type { WebBuildList as BuildList } from "@switchboard/release";

/** Платформа: на iPhone вне экрана «Домой» ключ ждёт в адресе. */
export type Platform = { ios: boolean; standalone: boolean };

export type StartOptions = {
  /** куда рисовать приложение */
  root: HTMLElement;
  /** адрес relay из сборки: wss://switchboard.<subdomain>.workers.dev — объект машины на /m/<машина> */
  relayUrl: string;
  /** Worker'ы флота из сборки: имя → адрес https; gate — список машин и приём приглашения */
  workers: Record<string, string>;
  /** fetch для POST к Worker'ам; по умолчанию глобальный */
  fetch?: typeof fetch;
  /** модули выпуска по порядку старта */
  parts: AppPart[];
  /** узкий (телефон) или широкий (пульт) вид */
  wide?: boolean;
  /** порядок разделов от оболочки: экраны с nav; разделов, которых здесь нет, — следом в порядке списка модулей */
  sections?: string[];
  /**
   * Широкий вид: экран → экран-список, рядом с которым он открывается (карточка — справа от списка сессий).
   * Пока открыт такой экран, список стоит слева в месте с классом sb-master; открыт сам список — на весь экран.
   */
  beside?: Record<string, string>;
  /** Имя приложения в колонке разделов широкого вида: «Пульт». */
  brand?: string;
  /** хранилище; по умолчанию IndexedDB «switchboard» */
  store?: Store;
  /** конструктор WebSocket для link; по умолчанию глобальный */
  WebSocket?: unknown;
  /** платформа; по умолчанию — по navigator */
  platform?: Platform;
  /** первая пауза переподключения, мс (растёт вдвое до 60 000) */
  pauseMs?: number;
  /** окно и документ; по умолчанию глобальные */
  window?: Window;
};

/** Запущенное приложение — для стенда и тестов. */
export interface Running {
  /** старт закончен: гейт, ключ, start модулей, связь открывается */
  readonly ready: Promise<void>;
  /** почему не стартовало или остановилось; null — работает */
  readonly stopped: string | null;
  /** модули, выключенные ошибкой: имя → причина */
  readonly failed: Record<string, string>;
  /** уйти с экрана штатно (как visibilitychange → hidden) */
  hide(): Promise<void>;
  /** вернуться на экран: снова start модулей и hello */
  show(): Promise<void>;
}
