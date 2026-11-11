// Контракт rules: правила замены текста запроса к модели — один движок для прокси Host и редактора пульта.
//   compile(rules) → { apply(scope, model, text, hits), flaws, empty } — набор по порядку, выключенные и неверные не применяются
//   editRequest(body, compiled) → hits — правила над телом Messages API на месте
//   applyRules(rules, scope, text, model?) → { after, hits } — проверка на одном тексте; flawOf(rule) → ошибка словами или ""
// Правила флота лежат в ключе proxy.rules области global у prefs; сама библиотека ни от чего не зависит.
export { applyRules, compile, editRequest, flawOf, SCOPES, type Hits, type MessagesBody, type Rule, type Scope } from "./src/rules.ts";
