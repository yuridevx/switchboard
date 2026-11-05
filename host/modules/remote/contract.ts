// Контракт модуля Host remote v1: Remote Control у каждой сессии.
//   поле roster remote: { url } — ссылка на сессию claude.ai, или { error } — отказ claude как есть
// Запросов нет: мост включён у всех сессий, привязку модуль снимает сам по своему правилу.
// Раздел сессии: { url, bridge, account } — account: кто был в слоте, когда мост включился.
import type { Module } from "@switchboard/host";

export function make(_o: { claudeDir?: string } = {}): Module {
  return { fields: { remote: () => undefined } };
}
export default make();
