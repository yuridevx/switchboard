// Состояние настроек: ответы keeper всех машин и то, что переживает смену вкладки.
import { createStore, machineAnswers, type App, type MachineAnswer } from "@switchboard/web-ui";
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
  /** чужие экраны, которым нужны свежие ответы */
  const opened: Array<() => void> = [];
  return {
    answers,
    local,
    open: () => void opened.push(answers.mount()),
    close: () => opened.pop()?.(),
  };
}

export type SettingsState = ReturnType<typeof createState>;
