// Контракт модуля Host logins: аккаунты Claude на машине и слоты. Имя аккаунта — его почта. Слот — ссылка на папку аккаунта; один аккаунт может стоять в нескольких слотах.
//   machine.accounts { machine, poll?: [почта] } → { accounts: { почта: { login: ok|none, plan?, expires?, limits: { окно: { utilization, resetsAt, at } } } }, slots: { имя: { account, order, wait } } }
//     poll — спросить Claude об этих аккаунтах сейчас; без него — записи, ни одного процесса Claude
//   machine.login { machine } → { url } — на машине один вход за раз, новый отменяет начатый
//   machine.login_code { machine, code } → { email, plan } — кто вошёл, говорит сервер Claude по токену
//   проверка: раз в 2 мин есть ли вход у каждого; по одному аккаунту за такт — чей токен в папке: чужая почта — «нет входа» и подмена
//   machine.account_remove { machine, account } → { wiped } — одним запросом: сменить в слотах на следующего, убрать из порядка, стереть
//   slot.set { machine, slot, order } → { account }  (пустой order удаляет слот без сессий)
//   slot.swap { machine, slot, account? } → { from, to }  («Сменить сейчас»)
//   session.slot { callsign, slot } → { restart } — slot обязателен, вывести сессию из слотов нельзя
//   поля roster: slot { name, wait }, account — почта
//   вход открытия: req.slot — имя слота; нет поля: один слот — он, больше — slot_required, нет — no_slot. Модуль выключен — отказ. Слот main заводит первый вход на машине без слотов
// Слова: no_account, no_slot, slot_required, not_logged_in, no_reserve, has_sessions, not_started, bad_code, login_failed,
// refresh_locked, slot_dir_busy, account_dir_busy, shutting_down; у no_slot и slot_required причина называет слоты машины.
import { make } from "./src/logins.ts";

export { make };
export default make();
