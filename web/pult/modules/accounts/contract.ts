// Контракт pult-accounts — страница «Аккаунты» (#accounts; раздел группы «Флот»): наверху лимиты каждого аккаунта, ниже машины строками.
// Аккаунт — окна: процент и час сброса; самое свежее значение среди машин; расходится тариф или час сброса — значок с тем, что говорит каждая машина.
// Открытие: записи всех машин (machine.accounts), затем один опрос на почту старше 2 мин; сменился account сессии в roster — опрос только нового.
// Строка машины (метка machines.rows, части — встроенный экран machine.parts): очередь её аккаунтов; нажатие открывает действия под строкой:
// slot.swap, slot.set, machine.account_remove; «＋ войти» — machine.login → ссылка и поле кода в строке, machine.login_code → кто вошёл; код уходит по TLS только машине, страница его не хранит.
import type { AppPart, Manifest } from "@switchboard/web-core";
import json from "./module.json" with { type: "json" };
import { createAccounts } from "./src/module.tsx";

export { createAccounts };

export const manifest: Manifest = json;
export default createAccounts satisfies AppPart["module"];
