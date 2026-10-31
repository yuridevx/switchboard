// Контракт модуля Host watch: живая лента сессии. Версия 1.
//   session.watch / session.unwatch { callsign } — зритель — from запроса; ответ ok.
//   session.watchers { callsign } → ["phone", "panel-desk"] — кто смотрит сейчас (им пользуется questions).
//   session.events { from, to: [зрители], seq, events: [сообщения SDK как есть] } — кадр без ответа, пачка за 100 мс.
import { make } from "./src/watch.ts";

export type { EventsFrame } from "./src/watch.ts";
export default make();
