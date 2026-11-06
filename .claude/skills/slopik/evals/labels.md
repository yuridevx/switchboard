# Размеченный набор для прогона домовых

База: ветка `demolish3`, коммит 5e1ac6d. Метки — из чтения кода 6 нояб., не из детектора.

## Настоящие дубли

| id | род | правило | где | владелец-кандидат | расхождения копий |
|---|---|---|---|---|---|
| D1 | ответственность | кадр → ответ: договор, запрос, отказ словом | `frame`/`serve`/`answer` в ledger, push, points, github, prefs, releases | `gate` (рядом с `entrance`) | github и prefs не отсекают `reply`; ledger.add идёт без id; releases отдаёт `why` в ответе и проверяет id до договора; push не пишет пустую причину |
| D2 | смысл/логика | класс отказа словом | `class Refusal` в ledger, push, points, github, releases и в ядре Host | спорно: `protocol`, `gate`, ядро | поля `reply`, `row`, `extra`, `why`; у ядра метка Symbol |
| D3 | механизм | журнал Worker: строка JSON с t и part | `log`/`line` в ledger, push, points, github, releases, инлайн в prefs | `gate` | сигнатура github другая |
| D4 | логика | сессия запроса по callsign | chat, manage, points (сняты в `slop-1`); logins, profiles с `!` (заморожены) | ядро Host | слова `bad_spec` и `offline`; `!` вместо отказа |
| D5 | логика | машина адреса | `machineOf` в chat и ask (сняты в `slop-1`) | `protocol` | копия не проверяет вид адреса |
| D6 | ответственность | окно подтверждения именем | `DeleteWindow` и `Unmark` в pult/points | pult/points | тексты, data-атрибуты |
| D7 | ответственность | секция выбора в карточке | `ProfileSec` и `SlotSec` в web/card | web/card | data-атрибуты, источник списка |
| D8 | механизм | настройка: стор и запись | `setView`, `pick`, `setHead`, `setInfo` | не решено | нет |
| D9 | логика | загрузка один раз на разговор | `models` и `commands` в talk.ts | web/chat | отказ: undefined или пустой список |

## Ложные кандидаты

| id | детектор | почему не дубль |
|---|---|---|
| F1 | одно имя `onRoster` ×6 | шесть разных дел по одному событию |
| F2 | jscpd `fleet-client` и `link` | общая форма запроса: один маршрутизирует, другой держит соединение |
| F3 | почти-клон `link` в points и releases | разные ключи и пути; общее — только вызов `presign` |
| F4 | почти-клон функция и её вложенный колбэк | ошибка измерителя, 124 пары |
| F5 | одно имя `session`, `answer`, `frame` | разные смыслы |

## Не проверено

- D4 в logins и profiles: кадр без `callsign` может выключать модуль; проба не дошла до конца.
- `bytesOf` и `unb64u`: разница в дополнении; разные приложения.
- `sessionOf` в web/ui и workers/points: код workers/points не читан, метки нет.
