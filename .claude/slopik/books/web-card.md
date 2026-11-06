# web-card

## Решения

| что | решение | причина |
|---|---|---|
| `card` `run` — `inbox` `restart` | оставлена | один запрос, тексты человеку разные |
| `board` `load`, `setView` — `card` `load`, `setHead` | оставлена | шаблон записи настройки, ключи и поля разные |
| `board` панель — `card` `HeadGroup` | оставлена | шаблон перебора чипов; `Choices` и `Chip` уже общие, у панели своё `disabled` |
| `web-ui` кнопки выбора — `card` `tabs.tsx:186`, `settings` `passes.tsx:77` | оставлена | шаблон JSX, подписи разные |
| `web-ui` `duration` — `ledger` `span` | оставлена | разные правила: 90 с — «1 мин 30 с» и «1 мин»; с 48 ч у `span` дни |
| `card` `Refused` — `settings` `Link` | оставлена | совпадение формы JSX |

## История

