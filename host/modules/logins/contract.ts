// Контракт модуля Host logins: аккаунты Claude на машине и слоты. Имя аккаунта — его почта. Слот — ссылка на папку аккаунта; один аккаунт может стоять в нескольких слотах.
//   machine.accounts { machine, poll?: [почта] } → { accounts: { почта: { login: ok|none, plan?, expires?, limits: { окно: { utilization, resetsAt, at } } } }, slots: { имя: { account, order, wait } } }
//     poll — спросить Claude об этих аккаунтах сейчас; без него — записи, ни одного процесса Claude
//   machine.login { machine } → { url } — на машине один вход за раз, новый отменяет начатый
//   machine.login_code { machine, code } → { email, plan } — кто вошёл, говорит сервер Claude по токену
//   проверка: раз в 2 мин есть ли вход у каждого; по одному аккаунту за такт — чей токен в папке: чужая почта — «нет входа» и подмена
//   machine.account_remove { machine, account } → { wiped } — одним запросом: сменить в слотах на следующего, убрать из порядка, стереть
//   slot.set { machine, slot, order } → { account }  (пустой order удаляет слот без сессий)
//   slot.swap { machine, slot, account? } → { from, to }  («Сменить сейчас»)
//   session.slot { callsign, slot } → { restart } — slot обязателен, вывести сессию из слотов нельзя; имя — слот машины или ключ флота
//   route { sid } → { to, key? } — куда идёт вызов модели сессии этой машины: слот-аккаунт — Anthropic, вход claude как есть; слот-ключ — адрес и значение ключа;
//     route { key } → { to, key, env, settings } — ключ флота для проверки: env — как у сессии на нём (без адреса, ANTHROPIC_API_KEY — слово fleet). Только вызов внутри Host (from — @эта машина), иначе denied; чужой sid — unknown_session
//   ключ флота: при выборе — fleetkeys.key с пределом; значение — только в памяти, настройки (env, settings) — в записи сессии: подъём читает их без связи;
//     после подключения и по кадру fleetkeys.changed — заново, ключа нет — значение забыто. У сессии на ключе ANTHROPIC_API_KEY — слово fleet, адреса провайдера нет: его знает прокси
//   поля roster: slot { name, wait }, account — почта
//   вход открытия: req.slot — имя слота или ключа флота; нет поля: один слот — он, больше — slot_required, нет — no_slot. Модуль выключен — отказ. Слот main заводит первый вход на машине без слотов
// Слова: no_account, no_slot, slot_required, not_logged_in, no_reserve, has_sessions, not_started, bad_code, login_failed, unknown_session, no_key, denied,
// refresh_locked, slot_dir_busy, account_dir_busy, shutting_down; у no_slot и slot_required причина называет слоты машины.
import { make } from "./src/logins.ts";

export { make };
export default make();
