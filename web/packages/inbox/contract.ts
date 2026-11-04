// Контракт web-inbox — «Вам» (общий пакет телефона и пульта): что ждёт вас. Карточки выводятся из roster и меток,
// своей очереди нет: вопрос (asked web-ask — ответ вариантом прямо в карточке экраном ask), сообщение (unread web-chat),
// «не запустилась» (state failed), «ждёт сброса лимита» (slot.wait), «машина ушла» (машина пропала из roster при
// открытом приложении; уход раньше — метка fire модуля точек), «готово» (busy → idle, пока карточка не открыта).
// Кроме вопроса и сообщения — только мои сессии (метка mine web-board). Карточка уходит сама, когда сменилось состояние.
// Метка you — число карточек: счётчик раздела.
import type { AppPart, Manifest } from "@switchboard/web-core";
import json from "./module.json" with { type: "json" };
import { createInbox } from "./src/module.tsx";

declare module "@switchboard/web-core" {
  interface Marks {
    you(): number;
  }
}

export { createInbox };
export const manifest: Manifest = json;
export default createInbox satisfies AppPart["module"];
