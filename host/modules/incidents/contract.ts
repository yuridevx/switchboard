// Контракт модуля Host incidents: инцидент от любого приложения компьютера — в одну сессию по типу и ключу.
//   HTTP POST http://127.0.0.1:<port>/incident, Content-Type: application/json, заголовок Host — 127.0.0.1 или localhost:
//     { type, key?, text, attachments?: [{ name, media_type, data(base64) }] } → 200 { callsign, new } · 400 { error }.
//   Слова: unknown_type, bad_frame, bad_attachment, bad_spec (папки типа нет), open_failed, no_profile, stopped;
//   shutting_down — Host останавливается посреди обращения (повтор после перезапуска — в ту же сессию); сбой модуля — 500 module_error.
//   Поле roster incident { type, key }; правило модуля — в системный промпт сессии инцидента.
// Настройка машины — host.json: "modules": { "host-incidents": { "port": 7717, "to": "phone~you@example.com",
//   "types": { "disk-full": { "profile": "you/profiles/disk-full", "dir": "~" } } } }.
import { make } from "./src/incidents.ts";

export { rule, wrap } from "./src/incidents.ts";
export type { Config, IncidentType } from "./src/incidents.ts";
export default make();
