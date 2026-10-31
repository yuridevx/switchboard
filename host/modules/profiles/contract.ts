// Контракт модуля Host profiles v1: профиль сессии — папка в git-репозитории (CLAUDE.md, profile.yaml, memory/).
//   session.profile { callsign, profile | null } → { restart }
//   machine.profiles { machine, sync? } → { profiles: { id: { model, effort, sessions } }, repos: { repo: { state, op?, files?, since?, error? } } }
//   поле roster: profile { id, state }
// Слово: no_profile. Настройка машины — host.json: "modules": { "host-profiles": { "repos": ["team/profiles"] } }.
import { make } from "./src/profiles.ts";

export type { RepoState } from "./src/profiles.ts";
export default make();
