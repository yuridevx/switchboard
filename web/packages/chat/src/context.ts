// Стор чата в экранах и контекст карточек. CardsCtx — что нужно карточкам ленты:
// живая лента и галерея дают его по-разному, карточки об этом не знают.
import { createContext, useContext } from "react";
import { useApp, useModule } from "@switchboard/web-ui";
import type { ChatStore, Conv } from "./state/chat.ts";
import type { Feed } from "./state/types.ts";

export const useChat = (): ChatStore => useModule<ChatStore>();

/** Выборка из разговора: компонент перерисуется, когда изменился её ответ. */
export function useConv<T>(cs: string, select: (c: Conv) => T): T {
  const app = useApp();
  const chat = useChat();
  return app.use(() => select(chat.conv(cs)));
}

export type CardsView = {
  /** лента, которую рисуют карточки */
  feed(): Feed;
  /** запрос разрешения этого инструмента ждёт человека */
  asking(toolUseId: string): boolean;
  /** имя сессии этой ленты */
  name: string;
  wide: boolean;
  /** «В фон» у идущей команды; нет — кнопки нет */
  background?(toolUseId: string): void;
  /** «Стоп» у идущей задачи */
  stopTask?(taskId: string): void;
  /** откат файлов к сообщению; нет — ссылки нет */
  rewind?(uuid: string): void;
  /** «Отправить ещё раз» своего сообщения без ответа */
  resend?(uuid: string, text: string): void;
  /** снять своё сообщение из очереди; нет — кнопки нет */
  unqueue?(uuid: string, text: string): void;
  /** текст обратно в поле ввода */
  edit?(text: string): void;
};

export const CardsCtx = createContext<CardsView | null>(null);
export const useCards = (): CardsView => useContext(CardsCtx)!;

/** Выборка из ленты карточек: карточка перерисуется, когда изменился её ответ. */
export function useFeed<T>(select: (f: Feed) => T): T {
  const app = useApp();
  const v = useCards();
  return app.use(() => select(v.feed()));
}

/** Запрос разрешения инструмента ждёт человека. */
export function useAsking(toolUseId: string): boolean {
  const app = useApp();
  const v = useCards();
  return app.use(() => v.asking(toolUseId));
}
