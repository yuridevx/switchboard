// Контракт модуля Host remote v1: Remote Control у каждой сессии.
//   поле roster remote: { url } — ссылка на сессию claude.ai, или { error } — отказ claude как есть
// Запросов нет: мост включён у всех сессий, привязку модуль снимает сам по своему правилу.
// Раздел сессии: { url, bridge, account } — account: кто был в слоте, когда мост включился.
import { remote } from "./src/remote.ts";

export type { RemoteRecord } from "./src/remote.ts";
export default remote();
