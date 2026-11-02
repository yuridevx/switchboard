// Контракт pult-accounts — аккаунты Claude, вход по ссылке и коду, слоты (свой пакет пульта).
// Экран accounts (#accounts; раздел группы «Флот»; в широком виде аккаунты и слоты рядом, в узком view=slots — слоты;
// machine — машина нового входа): карточка на почту со всех машин, «вошёл на N машинах», «＋ войти на машине…» — любая
// машина на связи без этой почты, имя на машине — то же; ссылка входа — кнопка и «Копировать». Карточка на почту
// со всех машин, окна — запись Host одной машины как пришла; расход почты с одной машины пульт пересылает
// её другим машинам (account.usage, src — имя машины), свежее выбирает их Host. Вход — machine.login → ссылка,
// machine.login_code → почта и тариф; код уходит по TLS только машине, пульт его не хранит.
// Слоты: «Сменить сейчас» — slot.swap, запас — slot.set, перевод сессий — session.slot. Подмену Host делает сам:
// сменился account сессий в roster — экран перечитывает слоты и окна этой машины.
// Метка logins — число идущих входов (login: pending) из последних ответов machine.accounts.
import type { AppModule, Manifest } from "@switchboard/web-core";
import json from "./module.json" with { type: "json" };
import { createAccounts } from "./src/accounts.ts";

export { createAccounts };
export const manifest: Manifest = json;
export default createAccounts() satisfies AppModule;
