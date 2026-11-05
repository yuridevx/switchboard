// Договор модуля веб-приложения: что модуль отдаёт ядру и что ядро даёт модулю.
import type { ComponentType, ReactNode } from "react";
import type { Frame, Roster } from "@switchboard/relay";
import type { Reply } from "@switchboard/protocol";
import type { App, ConnState, Ctx, Params } from "@switchboard/web-ui";
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
  /** компонент экрана; нет только у заглушки выключенного модуля */
  view?: ComponentType<ScreenProps>;
  /** шапка экрана на весь экран; у экрана в месте не спрашивается */
  head?(params: Params): Head;
};

/** Команда модуля: действие без экрана и адреса; зовётся app.run. Имя — ключ в commands и имя в provides. */
export type Command = {
  /** место, куда команда встаёт пунктом (card.menu, open.after); имя места — в uses модуля */
  place?: string;
  /** подпись пункта в месте */
  label?: string;
  /** виден ли пункт с этими параметрами; учитывает app.placed */
  show?(params: Params): boolean;
  run(params: Params): void;
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
    /** смена связи; open — hello принят: открытые экраны заново шлют свои подписки; machine — внутри открытого флота вернулась, пришла или перезапустилась только эта машина */
    link?(state: ConnState, machine?: string): void;
    /** открыт экран: человек перешёл, новый адрес или команда app.open */
    current?(c: { screen: string; params: Params }): void;
    /** страница вернулась на экран после ухода: забрать накопленное без неё */
    show?(): void | Promise<void>;
  };
  /** Экраны — имена из provides. */
  screens?: Record<string, Screen>;
  /** Команды — имена из provides. */
  commands?: Record<string, Command>;
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
  /**
   * Шов между модулями и связью — для стендов, прототипа и тестов. request: каждый запрос модуля, read — только читает,
   * real — отправить настоящий; roster: каждый roster до модулей.
   */
  seam?: { request(f: Frame, read: boolean, real: (f: Frame) => Promise<Reply>): Promise<Reply>; roster(r: Roster): Roster };
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
// App и его типы объявлены в наборе: стрелка ui ← core, ядро их реализует.
export type { App, ConnState, Ctx, Marks, Params, Result, Section, SlotProps } from "@switchboard/web-ui";
