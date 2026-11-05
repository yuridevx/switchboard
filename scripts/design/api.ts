// Договор мока дизайна: какие запросы его, что отвечать, какие записи безвредны, как править roster; своё состояние в памяти страницы.
// Мок — один файл <папка дизайна>/mock.ts.
import type { Frame, Reply } from "@switchboard/protocol";
import type { Roster } from "@switchboard/relay";

/** Ответ мока: результат или отказ словом; undefined — запрос не мока, решает набор. */
export type Answer = { ok: true; result?: unknown } | { ok: false; error: string; why?: string };

export type MockCtx<S = unknown> = {
  /** состояние мока в памяти страницы: взаимодействия с новым меняют его, следующие ответы его показывают */
  state: S;
  /** настоящий ответ прода на кадр — тем же путём, что пришёл этот: relay или Worker */
  real(f: Frame): Promise<Reply>;
  /** данные с диска машины: функция name из data.mjs папки дизайна */
  data<T = unknown>(name: string, params?: Record<string, unknown>): Promise<T>;
  /** тост на странице */
  notice(text: string): void;
};

export type ProtoMock<S = unknown> = {
  /** запросы договора дизайна: их отвечает только мок; молчание мока — ошибка прототипа, в прод они не уходят */
  owns?: string[];
  /** начальное состояние мока */
  state?(): S;
  /** службы, которых в проде ещё нет: имя → адрес-заглушка; кадры к ним отвечает только мок */
  workers?: Record<string, string>;
  /** записи, которые страница шлёт, но они ничего не меняют во флоте: идут в прод */
  harmless?: string[];
  /** до старта приложения: загрузить данные */
  init?(ctx: Pick<MockCtx<S>, "data" | "notice" | "state">): Promise<void> | void;
  /** ответ на кадр; undefined — не мой */
  answer?(f: Frame, ctx: MockCtx<S>): Promise<Answer | undefined> | Answer | undefined;
  /** roster объекта одной машины, как пришёл от relay */
  roster?(r: Roster, state: S): Roster;
};
