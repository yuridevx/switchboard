// Контракт модуля Host profiles v2: профиль сессии — упорядоченный список кусочков; кусочек — папка верхнего уровня git-репозитория в родных форматах Claude.
//   session.open { profile?: [id] } — чтение на открытии; session.profile { callsign, profile: [id] } → { restart }: пустой список — без кусочков; смена у живой сессии перезапускает её
//   machine.profiles { machine, sync? } → { profiles: { id: { about?, use?, kind, names } }, repos: { repo: { state, op?, files?, error?, dir, at } } }
//   profile.view { machine, profile: [id] } → { pieces, tree, settings: { ключ: { value, from, lost } }, skills, agents, instructions, memory: { home?, near }, prompt: { agent?, style? }, mcp, other, files: { id: [{ path, size, meta?, head? }] } }
//     тем же кодом, что собирает запуск, без текстов файлов; настройки env — ключами env.ИМЯ
//   profile.file { machine, id, path } → { text } — только по нажатию на файл; больше 256 КБ — too_large; выход из папки кусочка — bad_frame
//   поле roster: profile [{ id, state }] — список как выбран; state ok или error, причина в журнале
// Части кусочка: плагин; CLAUDE.md и правила — дополнительной папкой; settings.json — данными вклада уровня profile; memory/ — нижняя домашняя, остальные путём и индексом в промпте.
// Слова: bad_profile — список не собрать (кольцо наборов, манифест без name, два плагина с одним именем, кусочек задаёт провайдера, вход или папку памяти), no_profile — папки нет, too_large — файл больше предела.
// Список репозиториев — ключ fleet.profiles.repos настроек флота. Машина читает его на каждом такте сведения и копии не держит.
import { make } from "./src/profiles.ts";

export { make };
export type { Git } from "./src/profiles.ts";
export default make();
