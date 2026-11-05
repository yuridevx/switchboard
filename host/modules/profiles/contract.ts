// Контракт модуля Host profiles v1: профиль сессии — папка в git-репозитории (CLAUDE.md, profile.yaml, memory/, skills/).
//   session.profile { callsign, profile | null } → { restart }
//   machine.profiles { machine, sync? } → { profiles: { id: { model, effort, about? } }, repos: { repo: { state, op?, files?, since?, error? } } }
//   поле roster: profile { id, state }
//   окружение сессии с профилем: SWITCHBOARD_PROFILE=<id>; скилы профиля — «<папка>:<скил>»
// Слово: no_profile. Настройка машины — host.json: "modules": { "host-profiles": { "repos": ["team/profiles"] } }.
import { make } from "./src/profiles.ts";

export { make };
export type { Git } from "./src/profiles.ts";
export default make();
