// Стор чата в экранах и контекст карточек. CardsCtx — что нужно карточкам ленты:
// живая лента и галерея дают его по-разному, карточки об этом не знают.
import { createContext, useContext } from "react";
import { useModule } from "@switchboard/web-ui";
import type { ChatStore } from "./state/chat.ts";
import type { Feed } from "./state/types.ts";

export const useChat = (): ChatStore => useModule<ChatStore>();

export type CardsView = {
  /** выборка из ленты: карточка перерисуется, когда изменился её ответ */
  useFeed<T>(select: (f: Feed) => T): T;
  /** запрос разрешения этого инструмента ждёт человека */
  useAsking(toolUseId: string): boolean;
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
