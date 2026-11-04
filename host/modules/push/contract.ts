// Контракт модуля Host push: запрос notify v1 — «вот кадр для этих клиентов; кого нет на связи, достань пушем».
//   host.request("notify", { v: 1, clients: ["phone"], frame: { type: "question", from, notify: { title, body, actions, tag } } }) → ok
//   Ответ пустой: кому ушёл пуш, видно в журнале модуля и Worker'а.
// Пуш шлёт Worker-модуль push (push.send) по последнему roster; хранилища у модуля нет.
import { make } from "./src/push.ts";

export default make();
