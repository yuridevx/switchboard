// Что ядро даёт модулю: интерфейс App и его типы. Объявлены здесь, реализует ядро: набор не знает ядра, модуль видит один тип.
import type { ComponentType } from "react";
import type { Frame, Roster } from "@switchboard/relay";
/** Ответ запроса: результат или отказ словом. */
export type Result<T = unknown> = { ok: true; result: T } | { ok: false; error: string; why?: string };

/** Параметры экрана — пары в адресе после #: #card?callsign=site%40laptop. */
export type Params = Record<string, string>;

/** Как пришёл кадр: open — пользователь нажал уведомление с этим кадром, владелец открывает свой экран. */
export type Ctx = { open: boolean };

/** Состояние связи для модулей и шапки. */
export type ConnState = "connecting" | "open" | "closed" | "stopped";

/** Раздел хранилища модуля. */
export interface Section<T> {
  get(): Promise<T | undefined>;
  set(value: T): Promise<void>;
  update(fn: (old: T | undefined) => T): Promise<T>;
}

/** Типы меток: владелец дописывает свои в своём contract.ts (declare module "@switchboard/web-ui"). */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface Marks {}

/** Что принимает app.Slot. */
export type SlotProps = { screen: string; params?: Params; close?: () => void };

/** Что ядро даёт модулю. У каждого модуля свой объект: ядро знает, кто зовёт. */
export interface App {
  /** имя клиента во флоте — из ключа: client.phone.k2a9… → phone */
  readonly name: string;
  /** свой адрес во флоте: его отдаёт gate, проверяя пропуск; до ответа gate — null */
  address(): string | null;
  /** имя приложения из списка сборки: pult, phone; вне сборки — нет */
  readonly application?: string;
  /** широкий вид (пульт): экраны в местах; узкий (телефон): каждый экран на весь экран */
  readonly wide: boolean;
  /**
   * Запрос к Host или Worker-модулю: app.request("answer", { callsign, question, answers }).
   * Имя — только из uses модуля (иначе ошибка модуля); v ставит ядро из uses.
   * Владелец имени — Worker-модуль из roster (push) → to: .владелец; иначе адрес — callsign или machine кадра,
   * имя и версию проверяет получатель: нет — unknown_request, другая версия — contract_mismatch.
   * Не бросает: отказ — { ok: false, error, why? }; why — причина владельца, если он её назвал. Связи нет — disconnected сразу.
   */
  request<T = unknown>(name: string, body?: Record<string, unknown>): Promise<Result<T>>;
  /** Чтение: тот же вход, что у request, предел ответа 10 с — отказ словом timeout. Экранные выборки и вопросы о состоянии. */
  read<T = unknown>(name: string, body?: Record<string, unknown>): Promise<Result<T>>;
  /**
   * Открыть экран на весь экран с переходом в адресе.
   * Экран — свой, из uses модуля или вставленный в место, которым модуль владеет.
   */
  open(screen: string, params?: Params): void;
  /** Выполнить команду: свою, из uses модуля или вставленную в его место. Владелец выключен — ничего. */
  run(command: string, params?: Params): void;
  /** Экраны и команды, вставленные в место модуля и видимые с этими параметрами: имя места — из его provides (card.tab). */
  placed(place: string, params?: Params): Array<{ name: string; label: string }>;
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
  /** select получает прошлый ответ этой выборки: удержать значение без своей копии. */
  use<T>(select: (prev?: T) => T): T;
  /** Экран другого модуля внутри своего: своя граница ошибки и область стилей. Экран — как в app.open. */
  Slot: ComponentType<SlotProps>;
  /** Стор этого модуля — поле state его определения; экраны берут его хуком useModule. */
  readonly state: unknown;
}
