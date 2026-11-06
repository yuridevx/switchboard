// Контракт модуля Host profiles v2: профиль сессии — упорядоченный список кусочков; кусочек — папка верхнего уровня git-репозитория в родных форматах Claude.
//   session.open { profile?: [id] } — чтение на открытии; session.profile { callsign, profile: [id] } → { restart }: пустой список — без кусочков; смена у живой сессии перезапускает её
//   machine.profiles { machine, sync? } → { profiles: { id: { about?, use?, kind, names } }, repos: { repo: { state, op?, files?, error?, dir, at } } }
//   поле roster: profile [{ id, state }] — список как выбран; state ok или error, причина в журнале
// Части кусочка: плагин; CLAUDE.md и правила — дополнительной папкой; settings.json — данными вклада уровня profile; memory/ — нижняя домашняя, остальные путём и индексом в промпте.
// Слова: bad_profile — список не собрать (кольцо наборов, манифест без name, два плагина с одним именем, кусочек задаёт провайдера, вход или папку памяти), no_profile — папки нет.
// Список репозиториев — ключ fleet.profiles.repos настроек флота. Машина читает его на каждом такте сведения и копии не держит.
import { make } from "./src/profiles.ts";

export { make };
export type { Git } from "./src/profiles.ts";
export default make();
