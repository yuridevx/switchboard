// Список живых проверок — строки и выбор, без запуска: запускает выбранное tools/fleet/live.mjs.
// Строка: [название, файл, аргументы, окружение, где идёт, дорожка, что нужно от места].
// Где идёт — слова через пробел:
//   коробка — флот в коробке, CI до слияния (весь список, кроме того, чего у коробки нет);
//   флот    — живой тестовый флот после каждого слияния: швы — проверки, чьё свойство требует настоящей службы;
//   прод    — проверка прода: свои пробные сессии, чужие не трогает, машины не перезапускает;
//   руками  — на живом тестовом флоте только при запуске всего списка (SB2_ALL=1).
// Дорожки:
//   тихая  — никого не задевает: все тихие идут разом на первой машине; вторую машину тихая строка не получает вовсе;
//   шумная — перезапускает Host своей машины или делит общий ресурс с другой шумной: шумные идут по очереди, им отдана вторая машина;
//   одна   — меняет общее для флота (аккаунты Claude, состав проекта): идёт до остальных, по одной.
// Что нужно — имена из lacks (tools/fleet/harness.mjs) и install — служба ОС ставится на этом компьютере (раннер CI, SB2_INSTALL=1).

export const QUIET = "тихая", NOISY = "шумная", ALONE = "одна";
export const BOX = "коробка", FLEET = "флот", PROD = "прод", HAND = "руками";
export const PLACES = [BOX, FLEET, PROD, HAND];

/** Строки списка. c: fleet, device — флот и устройство; machine, second — первая и вторая машины; pairs — пары «ключ/модель» смены модели;
 *  bigMb — размер большого файла «файлов сессии». */
export const rows = ({ fleet, device, machine, second, pairs = [], bigMb = "10" }) => [
  ["запросы", "smoke.ts", [fleet, device], {}, "коробка флот прод", QUIET],
  // копию на второй машине поднимает своя часть на шумной дорожке
  ["серверные функции", "live-server.ts", [fleet, device, machine], { SB2_PART: "near" }, "коробка руками", QUIET],
  ["серверные функции: вторая машина", "live-server.ts", [fleet, device, machine, second], { SB2_PART: "far" }, "коробка руками", NOISY, ["r2"]],
  ["часы флота", "live-clock.mjs", [fleet, device], {}, "коробка флот прод", QUIET],
  // заводит и убирает проект проверки: состав проекта рвёт соединения страниц человека — идёт до всех
  ["тикеты", "live-tickets.ts", [fleet, device, machine], {}, "коробка руками", ALONE],
  // правила входа идут по определению из репозитория кусочков коробки: на живом флоте такого репозитория у проверки нет
  ["правила входа", "live-rules.ts", [fleet, device], {}, "коробка", QUIET],
  // очередь поста идёт по определению второго проекта коробки — из папки кусочка того же репозитория
  ["очередь поста", "live-queue.ts", [fleet, device], {}, "коробка", QUIET],
  ["страница в браузере", "live-page.mjs", [fleet, device, machine], {}, "коробка флот прод", QUIET],
  ["разделы страницы", "live-bar.mjs", [fleet, device, machine], {}, "коробка руками прод", QUIET],
  ["оповещение о сбое", "live-alert.mjs", [fleet, device], {}, "флот", QUIET, ["push"]],
  ["флоу без окон", "live-flows.mjs", [fleet, device, machine], { SB2_PART: "rest" }, "коробка руками", QUIET],
  ["комментарии к странице", "live-comments.mjs", [fleet, device], {}, "коробка руками", QUIET],
  // длинные проверки идут частями (SB2_PART): у каждой части свои сессии, части идут разом
  ["откат разговора", "live-rewind.ts", [fleet, device, machine], { SB2_PART: "rewind" }, "коробка руками", QUIET],
  ["пара: ведущая и ведомый", "live-rewind.ts", [fleet, device, machine], { SB2_PART: "pair" }, "коробка руками", QUIET],
  ["разговор на странице: ходы", "live-talk.mjs", [fleet, device, machine], { SB2_PART: "turn" }, "коробка руками", QUIET],
  ["разговор на странице: живое", "live-talk.mjs", [fleet, device, machine], { SB2_PART: "live" }, "коробка руками", QUIET],
  ["разговор на странице: экран", "live-talk.mjs", [fleet, device, machine], { SB2_PART: "screen" }, "коробка руками", QUIET],
  ["аккаунты и модели", "live-accounts.ts", [fleet, device, machine], { SB2_PART: "rest" }, "коробка флот", QUIET, ["claude"]],
  // отказ провайдера на негодный PDF воспроизводится на Claude: у этой проверки свой ключ и модель
  ["ошибки на виду", "live-errors.mjs", [fleet, device, machine], { SB2_KEY: "claude", SB2_MODEL: "claude-haiku-5-5" }, "коробка флот", QUIET, ["claude", "r2"]],
  ["файлы сессии", "live-files.mjs", [fleet, device, machine], { SB2_BIG_MB: bigMb }, "коробка флот", QUIET, ["r2"]],
  ["смена модели", "live-switch.mjs", [fleet, device, machine, ...pairs], {}, "коробка флот", QUIET],
  // память проекта — папка кусочка из git: замок записи по модели, след, кусочки родителя у дочерней; модели — аккаунты Claude.
  // Пишет в репозиторий кусочков вместе со «сценариями: вторая машина» — в одной очереди с ней
  ["память флота", "live-memory.mjs", [fleet, device, machine], {}, "коробка флот", NOISY, ["claude", "github"]],
  ["сценарии", "live-steps.ts", [fleet, device, machine], { SB2_PART: "one" }, "коробка руками", QUIET],
  ["связь сессий и карточки входящего", "live-comms.ts", [fleet, device, machine], { SB2_PART: "talk" }, "коробка руками", QUIET],
  // свой позывной и правила после сжатия называет только модель, которая понимает прочитанное
  ["связь сессий: правила после сжатия", "live-comms.ts", [fleet, device, machine], { SB2_PART: "mind" }, "флот", QUIET, ["mind"]],
  // описание клиента флот читает по публичному адресу https — клиент настоящий: Claude Code
  ["вход внешнего клиента", "live-oauth.mjs", [fleet, device], {}, "коробка руками", QUIET],
  // вторая машина: её Host перезапускает подмена — всё, что трогает вторую машину, идёт с ней в одной очереди
  ["сценарии: вторая машина", "live-steps.ts", [fleet, device, machine, second], { SB2_PART: "far" }, "коробка руками", NOISY],
  ["подмена Host посреди хода", "live-comms.ts", [fleet, device, second], { SB2_PART: "swap" }, "коробка руками", NOISY, ["keeper"]],
  // меняет состав проекта: платформа при этом рвёт соединения всех страниц человека — идёт до всех
  ["флоу: галочка проекта", "live-flows.mjs", [fleet, device], { SB2_PART: "people" }, "коробка руками", ALONE],
  // человека в Telegram играет двойник коробки; бот — общий для флота, а человек проверки не должен быть на связи страницей — идёт до всех
  // и без соединения картины (SB2_AWAY): оно и есть «человек на связи»
  ["переписка с человеком", "live-rooms.mjs", [fleet, device, machine], { SB2_AWAY: "1" }, "коробка", ALONE],
  // ставит службу в ОС компьютера; новая машина флота не должна попасть под выкладку — идёт одна
  ["установка службы машины", "live-install.mjs", [fleet, device], {}, "коробка", ALONE, ["install"]],
  // подменяет Host на всех машинах флота — идёт до всех; на живой флот сборку доводит CI
  ["выкладка сборки", "live-roll.mjs", [fleet, device, machine, second], {}, "коробка", ALONE],
  // заводит и убирает негодный аккаунт Claude флота: при нём чужой ход на Claude получил бы лишний переход — идёт до всех
  ["аккаунты: негодный токен", "live-accounts.ts", [fleet, device, machine], { SB2_PART: "token" }, "коробка руками", ALONE, ["claude"]],
];

/** Выбор строк для места. place — коробка, флот или прод; all — на флоте весь список (ещё и «руками»); lacks(что) — у места этого нет;
 *  only — одна строка по названию, мимо долей; shard из shards — доля списка: строка идёт ровно в одну долю. */
export function select(list, { place, shard = 1, shards = 1, only = "", lacks = () => false, all = false }) {
  const goes = ([, , , , where, , needs = []]) => {
    const w = where.split(" ");
    return (w.includes(place) || (place === FLEET && all && w.includes(HAND))) && !needs.some(lacks);
  };
  return list.filter(goes).filter((r, i) => (only ? r[0] === only : i % shards === shard - 1));
}
