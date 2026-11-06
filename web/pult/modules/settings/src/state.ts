// Состояние настроек: ответы keeper и репозитории всех машин, список репозиториев флота и то, что переживает смену вкладки.
import { machineOf } from "@switchboard/protocol";
import { FLEET_PREFIX } from "@switchboard/records";
import { createStore, isLive, machineAnswers, machinesWith, personal, type App, type MachineAnswer, type ProfilesAnswer } from "@switchboard/web-ui";
import type { KState } from "./rules.ts";

export type KeeperAnswers = Readonly<Record<string, MachineAnswer<KState>>>;
export type Invited = { kind: "device" | "program" | "host"; addr: string; invite: string };
type Local = {
  /** отмеченные машины матрицы */
  checked: string[];
  catalog: boolean;
  /** что выкладывается: часть; итог выкладки — строкой */
  deploying: string;
  deployed: { text: string; tone: "ok" | "bad" } | null;
  invited: Invited | null;
  /** вкладка, которую открыли последней: заход без адреса вкладки возвращает на неё */
  tab: string;
};

export function createState(app: App) {
  const answers = machineAnswers<KState>(app, (m) => app.read<KState>("keeper.state", { to: `.keeper@${m}` }));
  const local = createStore<Local>({ checked: [], catalog: false, deploying: "", deployed: null, invited: null, tab: "releases" }, () => app.changed());
  const asked = () => machinesWith(app, "machine.profiles");
  const repos = machineAnswers<ProfilesAnswer>(app, (m) => app.read<ProfilesAnswer>("machine.profiles", { machine: m }), asked);
  const fleet = personal(app, FLEET_PREFIX, () => app.changed(), "global");
  /** чужие экраны, которым нужны свежие ответы */
  const opened: Array<() => void> = [];
  return {
    answers,
    local,
    repos,
    fleet,
    /** «Свести везде»: каждая машина сводит и отвечает своим состоянием */
    syncRepos: () => Promise.all(asked().map((m) => repos.reload(m, (machine) => app.request<ProfilesAnswer>("machine.profiles", { machine, sync: true })))),
    /** «Перечитать сессии»: по запросу на каждую живую сессию, отказ — ответ этой сессии */
    reloadSessions: () => Promise.all((app.roster()?.sessions ?? []).filter((s) => isLive(s.state) && app.can(machineOf(s.callsign)!, "session.reload") === true).map(async ({ callsign }) => ({ callsign, r: await app.request("session.reload", { callsign }) }))),
    open: () => void opened.push(answers.mount()),
    close: () => opened.pop()?.(),
  };
}

export type SettingsState = ReturnType<typeof createState>;
