// Стор настроек: ответы keeper'ов всех машин — их единственный владелец; вид вкладки, отметки, итог выкладки и приглашение переживают смену вкладки; код от GitHub из адреса.
import { createStore, machineAnswers, type App, type MachineAnswers } from "@switchboard/web-ui";
import { wordText, type KState } from "./rules.ts";

export type KeeperAnswers = MachineAnswers<KState>;
export type Invited = { addr: string; invite: string; kind: "device" | "program" | "machine" };
export type Note = { text: string; tone: "ok" | "bad" };

export type SettingsState = ReturnType<typeof createSettingsState>;

export function createSettingsState(app: App) {
  const keeper = machineAnswers<KState>(app, (machine) => app.read<KState>("keeper.state", { to: `.keeper@${machine}` }));
  const s = createStore({ view: "machines" as "machines" | "catalog", marked: [] as string[], deploying: "", deployed: null as Note | null, invited: null as Invited | null, code: "" }, app.changed);
  const closers: Array<() => void> = [];
  return {
    keeper,
    get: s.get,
    /** чужой экран открыт и закрыт: ответы свежие, пока кто-то смотрит */
    openKeeper: () => void closers.push(keeper.mount()),
    closeKeeper: () => closers.pop()?.(),
    setView: (view: "machines" | "catalog") => s.set((d) => void (d.view = view)),
    setMarked: (marked: string[]) => s.set((d) => void (d.marked = marked)),
    setInvited: (invited: Invited | null) => s.set((d) => void (d.invited = invited)),
    setCode: (code: string) => s.set((d) => void (d.code = code)),
    /** Выкладка идёт десятки секунд: итог виден и после смены вкладки. */
    async deploy(part: string, version: string, done: () => void) {
      s.set((d) => {
        d.deploying = `${part}:${version}`;
        d.deployed = null;
      });
      const r = await app.request<{ parts: Record<string, { from: string; to: string }> }>("releases.deploy", { part, version });
      s.set((d) => {
        d.deploying = "";
        d.deployed = r.ok ? { tone: "ok", text: `Выложено: ${Object.entries(r.result.parts).map(([p, v]) => `${p} ${v.from} → ${v.to}`).join(", ")}` } : { tone: "bad", text: `Не выложен ${part} ${version}: ${wordText(r.error)}` };
      });
      done();
      if (r.ok) await Promise.all(Object.keys(keeper.get()).map((m) => keeper.reload(m)));
    },
  };
}
