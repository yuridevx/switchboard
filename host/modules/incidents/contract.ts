// Контракт модуля Host incidents: инцидент от любого приложения компьютера — в одну сессию по типу и ключу.
//   HTTP POST http://127.0.0.1:<port>/incident, Content-Type: application/json, заголовок Host — 127.0.0.1 или localhost:
//     { type, key?, text, attachments?: [{ name, media_type, data(base64) }] } → 202 { id } сразу, без ожидания сессии · 400 { error }.
//   Слова POST: bad_frame, unknown_type, bad_attachment; сбой модуля — 500 module_error.
//   Доставка хотя бы раз: принятое обращение лежит на диске Host, пока ход сессии его не взял (uuid = id в user_message_uuids);
//   повтор — тот же id в теге <incident>. Отказ доставки (open_failed, no_profile, bad_spec, stopped, shutting_down…) — строка
//   журнала ev incident с id; обращение ждёт следующего старта Host или следующего обращения.
//   Поле roster incident { type, key }; правило модуля — в системный промпт сессии инцидента.
// Настройка машины — host.json: "modules": { "host-incidents": { "port": 7717, "to": "phone~you@example.com",
//   "types": { "disk-full": { "profile": "you/profiles/disk-full", "dir": "~" } } } }.
import { make } from "./src/incidents.ts";

export { rule, wrap } from "./src/incidents.ts";
export type { Config, IncidentType } from "./src/incidents.ts";
export default make();
