// Договор модуля веб-приложения: что модуль отдаёт ядру и что ядро даёт модулю.
import type { ComponentType, ReactNode } from "react";
import type { Frame, Roster } from "@switchboard/relay";
import type { Result } from "@switchboard/web-ui";
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
  /** лампа слева от заголовка: состояние без слов */
  dot?: string;
  /** заголовок моноширинным — позывной */
  mono?: boolean;
  /** кнопка шапки на телефоне: главное действие раздела */
  action?: { label: string; text: string; run(): void };
};

/** Что получает компонент экрана. */
export type ScreenProps = {
  /** из адреса, из app.open или из app.Slot; новые параметры — экран начат заново */
  params: Params;
  /** экран закрылся сам (окно в месте): передаёт вызывающий через app.Slot */
  close?: () => void;
};

/** Экран модуля. Имя экрана — ключ в screens и имя в provides модуля. */
export type Screen = {
  /** раздел навигации: на телефоне — шапка, в пульте — колонка слева; первый раздел — домашний */
  nav?: string;
  /** метка-счётчик раздела — имя из marks этого модуля, число */
  mark?: string;
  /**
   * Группа раздела («Флот»): в широком виде — подпись над разделами группы, в узком — одна вкладка,
   * разделы группы — лентой над экраном.
   */
  group?: string;
  /** Группа раздела только в узком виде (телефон): «Инциденты» — во «Флоте» телефона, в колонке пульта — отдельно. */
  narrowGroup?: string;
  /** Что экран отдаёт поиску Ctrl K: строки, ведущие на экран этого модуля или экран из его uses. */
  find?(q: string): Array<{ label: string; hint?: string; dot?: string; screen: string; params?: Params }>;
  /**
   * Место, куда экран встаёт: «top» — полоса ядра над экранами разделов («Включить уведомления»); другое имя — место
   * модуля-владельца внутри его экрана (card.tab — вкладка карточки). Имя места — в uses модуля: top@web-core, card.tab@web-card.
   */
  place?: string;
  /** видна ли вставка с этими параметрами (вкладка — этой сессии); учитывает app.placed */
  show?(params: Params): boolean;
  /** путь в адресе после #; по умолчанию — имя экрана */
  path?: string;
  /** человеческое имя: подпись вставки в месте (вкладка «Точки») и экран упавшего модуля — «Лента выключена» */
  label?: string;
  /** компонент экрана; у команды его нет */
  view?: ComponentType<ScreenProps>;
  /** шапка экрана на весь экран; у экрана в месте не спрашивается */
  head?(params: Params): Head;
  /** команда вместо экрана (пункт меню в чужом месте): app.open зовёт run и никуда не переходит */
  run?(params: Params): void;
};

/**
 * Определение модуля: его отдаёт функция модуля (default export contract.ts). Все поля необязательны.
 * Ловушка ошибок: каждый вызов модуля и отрисовку его экранов ядро ловит. Бросил — модуль выключен до перезапуска
 * приложения: его кадры дальше не идут, метки пусты, на его экранах — причина. Остальные работают.
 */
export interface AppModule {
  /** Стор модуля: экраны берут его хуком useModule из web-ui. */
  state?: unknown;
  /** Кадры по type — их имена должны быть в uses модуля (имя@владелец). У кадра один принимающий модуль. */
  frames?: Record<string, (f: Frame, ctx: Ctx) => void>;
  on?: {
    /** roster от relay — модулям, у которых roster@relay в uses */
    roster?(r: Roster): void;
    /** смена связи; open — hello принят: открытые экраны заново шлют свои подписки; machine — вернулась только эта машина внутри открытого флота */
    link?(state: ConnState, machine?: string): void;
    /** открыт экран: человек перешёл, новый адрес или команда app.open */
    current?(c: { screen: string; params: Params }): void;
    /** страница вернулась на экран после ухода: забрать накопленное без неё */
    show?(): void | Promise<void>;
  };
  /** Экраны — имена из provides. */
  screens?: Record<string, Screen>;
  /** Метки для других модулей (asked, unread, need) — имена из provides. */
  marks?: Record<string, (...args: string[]) => unknown>;
  /** Разделы хранилища модуля; у раздела один владелец, key — раздел ядра. */
  store?: string[];
  /** Стили модуля: ядро ограничивает их местом модуля (@scope до вложенного модуля). */
  css?: string;
  /** Поднять своё из хранилища: ядро зовёт по порядку списка один раз при старте. */
  start?(): void | Promise<void>;
  /** Штатная остановка при уходе с экрана: дописать хранилище, снять подписки. Порядок обратный. */
  stop?(): void | Promise<void>;
}

/** Ответ на запрос: результат или слово ошибки (offline, disconnected, already_answered, …). */
export type { Result };

/** Раздел хранилища модуля. */
export interface Section<T> {
  get(): Promise<T | undefined>;
  set(value: T): Promise<void>;
  update(fn: (old: T | undefined) => T): Promise<T>;
}

/** Типы меток: владелец дописывает свои в своём contract.ts (declare module "@switchboard/web-core"). */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface Marks {}

/** Что принимает app.Slot. */
export type SlotProps = { screen: string; params?: Params; close?: () => void };

/** Что ядро даёт модулю. У каждого модуля свой объект: ядро знает, кто зовёт. */
export interface App {
  /** имя клиента во флоте — из ключа: client.phone.k2a9… → phone */
  readonly name: string;
  /** имя приложения из списка сборки: pult, phone; вне сборки — нет */
  readonly application?: string;
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
   * Открыть экран на весь экран с переходом в адресе; у команды — вызвать её run.
   * Экран — свой, из uses модуля или вставленный в место, которым модуль владеет.
   */
  open(screen: string, params?: Params): void;
  /** Экраны, вставленные в место модуля и видимые с этими параметрами: имя места — из его provides (card.tab). */
  placed(place: string, params?: Params): Array<{ screen: string; label: string }>;
  /** Назад: на прошлый экран или на домашний раздел. */
  back(): void;
  /** Умеет ли машина запрос: true/false по её contract из последнего roster; машины нет в roster — null. */
  can(machine: string, name: string): boolean | null;
  /** Последний roster; ядро держит его в памяти. */
  roster(): Roster | null;
  /** Адрес Worker'а или страницы флота с этим именем — из списка адресов сборки, а не из roster; нет — null. */
  worker(name: string): string | null;
  /** Экран на весь экран сейчас и его параметры (в широком виде — правая часть); до первого roster — null. */
  current(): { screen: string; params: Params; master: string | null } | null;
  /** Связь сейчас. */
  link(): ConnState;
  /** Метка другого модуля из uses: app.mark("asked", "profiles@laptop"). Выключенный владелец — undefined. */
  mark<K extends keyof Marks>(name: K, ...args: Marks[K] extends (...a: infer A) => unknown ? A : never): (Marks[K] extends (...a: never[]) => infer R ? R : never) | undefined;
  mark(name: string, ...args: string[]): unknown;
  /** Свой раздел хранилища (из store модуля). */
  store<T = unknown>(section: string): Section<T>;
  /** Кадр — модулю-владельцу его type, как пришедший с relay. */
  deliver(frame: Frame, ctx?: Ctx): void;
  /** Метки или данные модуля изменились: ядро заново считает выборки app.use (один раз за такт). */
  changed(): void;
  /** Короткая строка внизу экрана: отказ, который надо увидеть. */
  toast(text: string, tone?: "ok" | "bad"): void;
  /**
   * Хук: выборка из данных ядра и модуля. Компонент перерисуется, только когда ответ изменился.
   * Сравниваются простые объекты и массивы по содержимому, остальное — по ссылке; выборка отдаёт данные, а не функции.
   */
  use<T>(select: () => T): T;
  /** Экран другого модуля внутри своего: своя граница ошибки и область стилей. Экран — как в app.open. */
  Slot: ComponentType<SlotProps>;
  /** Стор этого модуля — поле state его определения; экраны берут его хуком useModule. */
  readonly state: unknown;
}

/** Модуль выпуска: манифест и функция модуля. Ядро зовёт её один раз со своим app; бросила — модуль выключен. */
export type AppPart = { manifest: Manifest; module: (app: App) => AppModule };

/** Модуль с определением: что проверяет гейт набора. */
export type DefinedPart = { manifest: Manifest; module: AppModule };

/** Список сборки страницы — build.json рядом со страницей; формат — у владельца формата выпуска. */
export type { BuildList } from "@switchboard/release";

/** Платформа: на iPhone вне экрана «Домой» ключ ждёт в адресе; scope: false — браузер без @scope. */
export type Platform = { ios: boolean; standalone: boolean; scope?: boolean };

export type StartOptions = {
  /** куда рисовать приложение */
  root: HTMLElement;
  /** Worker'ы флота из сборки: имя → адрес https; relay — объекты машин, gate — список машин и приём приглашения */
  workers: Record<string, string>;
  /** fetch для POST к Worker'ам; по умолчанию глобальный */
  fetch?: typeof fetch;
  /** модули выпуска по порядку старта */
  parts: AppPart[];
  /** имя приложения из списка сборки */
  application?: string;
  /** узкий (телефон) или широкий (пульт) вид */
  wide?: boolean;
  /** порядок разделов от оболочки: экраны с nav; разделов, которых здесь нет, — следом в порядке списка модулей */
  sections?: string[];
  /**
   * Широкий вид: экран → экран-список (или списки), рядом с которым он открывается (карточка — справа от «Вам» и от «Работы»):
   * из нескольких — тот, что уже стоит слева или открыт сейчас, иначе первый.
   * Пока открыт такой экран, список стоит слева в месте с классом sb-master; открыт сам список — на весь экран.
   */
  beside?: Record<string, string | string[]>;
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
  /** вернуться на экран: on.show модулей и hello */
  show(): Promise<void>;
  /** снять вид со страницы: стенд перед следующим приложением */
  unmount(): void;
}

export type { ReactNode };

// App модуля в контексте экрана: значение и хук — в наборе, тип дописывает ядро.
declare module "@switchboard/web-ui" {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface AppHandle extends App {}
}
