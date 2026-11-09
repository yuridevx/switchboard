// Контракт pult-people — люди флота: единственное место пропусков в пульте (раздел группы «Флот»). Только идентификация: прав нет,
// любой живой пропуск может всё. Человек — его почта: ~ann@example.com, устройства pult~ann@example.com; приглашают людей по почте.
// Вид пропуска — форма адреса (kindOf протокола): машина, устройство, сессия; программа — устройство.
// Экран people (#people, параметр who — карточка человека с возвратом к списку): люди по пропускам keys.list {passes: [{kid, addr, owner,
// wait}], you} — устройства по адресу, машины по owner; «на связи» по roster.clients и машинам roster, «это устройство», ждущие приглашения;
// приглашение keys.invite {addr, owner?} (owner — только у машины, "~почта") с одной выдачей: ссылки на пульт и телефон (page@phone), QR,
// код; отзыв keys.revoke; удаление человека — отзыв его устройств, машины остаются; имя — fleet.labels.people области флота, ключ — почта.
// Экран consent — точка authorize OAuth (адрес <пульт>/?open=consent&client_id=…&redirect_uri=…&state=…&code_challenge=…): имя устройства
// по умолчанию из client_id; «Разрешить» — отзыв прежнего пропуска с тем же адресом, keys.invite {addr, challenge, client, back} и возврат
// браузера в redirect_uri с code и state; «Отказать» — возврат с error=access_denied. Отказ gate — словом. Открыта одна форма за раз,
// Escape закрывает.
import type { AppPart, Manifest } from "@switchboard/web-core";
import json from "./module.json" with { type: "json" };
import { createPeople } from "./src/module.tsx";

export { createPeople };
export const manifest: Manifest = json;
export default createPeople satisfies AppPart["module"];
