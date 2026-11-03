// Состояние профилей: ответы machine.profiles всех машин, сведённые в строки по id. Конфликт — состояние репозитория профиля на машине.
import type { App, Roster } from "@switchboard/web-core";
import { machineOf } from "@switchboard/protocol";
import { createStore, folderOf, lamp, machineLabel, profileIdOf, profileName as short, sessionLabel } from "@switchboard/web-ui";

type Repo = { state: "ok" | "error" | "conflict"; files?: string[]; error?: string };
type Answer = { profiles: Record<string, { model?: string | null; effort?: string | null; about?: string }>; repos: Record<string, Repo> };
type Reply = Answer | { error: string };

type State = {
  answers: Record<string, Reply>;
  /** открытые экраны: машина, пришедшая при открытом экране, спрашивается сразу */
  opened: number;
};

const repoOf = (id: string) => id.slice(0, id.lastIndexOf("/"));

/** Строки: id → машины, описание и модель первой ответившей, машины с конфликтом. */
function rowsOf(answers: Record<string, Reply>) {
  const out = new Map<string, { id: string; about: string; model: string; effort: string; ms: string[]; cf: Array<{ m: string; repo: Repo }> }>();
  for (const [m, a] of Object.entries(answers)) {
    if ("error" in a) continue;
    for (const [id, p] of Object.entries(a.profiles)) {
      const row = out.get(id) ?? { id, about: p.about ?? "", model: p.model ?? "", effort: p.effort ?? "", ms: [], cf: [] };
      row.ms.push(m);
      out.set(id, row);
      const repo = a.repos[repoOf(id)];
      if (!repo || repo.state === "ok") continue;
      // файлы конфликта — под папками профилей: конфликт у того, чьи файлы; ни под чьей — у всех профилей репозитория
      const files = repo.files ?? [];
      const own = files.filter((f) => f.startsWith(`${short(id)}/`));
      const anyone = files.some((f) => Object.keys(a.profiles).some((x) => f.startsWith(`${short(x)}/`)));
      if (own.length || !anyone) row.cf.push({ m, repo: { ...repo, files: own.length ? own : files } });
    }
  }
  return [...out.values()];
}

export type ProfilesStore = ReturnType<typeof createProfilesStore>;
export type ProfileRowData = ReturnType<ProfilesStore["summary"]>["all"][number];

export function createProfilesStore() {
  let app: App;
  const store = createStore<State>({ answers: {}, opened: 0 }, () => app.changed());

  const can = (m: string) => app.can(m, "machine.profiles") === true;
  const machines = () => (app.roster()?.machines ?? []).map((m) => m.machine).filter(can);
  const mLabel = (m: string) => machineLabel(app, m).text;

  async function load(m: string, sync = false) {
    const r = await app.request<Answer>("machine.profiles", sync ? { machine: m, sync: true } : { machine: m });
    store.set((s) => void (s.answers[m] = r.ok ? r.result : { error: r.error }));
  }

  return {
    start(a: App) {
      app = a;
    },
    /** Машина пришла при открытом экране — спросить и её. */
    onRoster(r: Roster) {
      const { opened, answers } = store.get();
      if (opened) for (const x of r.machines) if (!answers[x.machine] && can(x.machine)) void load(x.machine);
    },
    /** Экран открыт: спросить машины; возврат — экран закрыт. */
    mount(): () => void {
      store.set((s) => void s.opened++);
      for (const m of machines()) void load(m);
      return () => store.set((s) => void s.opened--);
    },
    /** Всё, что показывает экран: простые данные, сравниваются по содержимому. */
    summary() {
      const sessions = app.roster()?.sessions ?? [];
      const { answers } = store.get();
      const replies = Object.values(answers);
      return {
        all: rowsOf(answers).map((r) => ({
          ...r,
          ms: r.ms.map((m) => ({ m, label: mLabel(m) })),
          cf: r.cf.map((x) => ({ ...x, label: mLabel(x.m) })),
          run: sessions
            .filter((s) => profileIdOf(s) === r.id)
            .map((s) => {
              const n = sessionLabel(app, s.callsign);
              return { callsign: s.callsign, lamp: lamp(s), text: n.text, human: n.human, place: `${mLabel(machineOf(s.callsign) ?? "")} · ${folderOf(s.dir)}` };
            }),
        })),
        repos: [...new Set(replies.flatMap((a) => ("error" in a ? [] : Object.keys(a.repos))))],
        errors: Object.entries(answers).flatMap(([m, a]) => ("error" in a ? [`${mLabel(m)}: machine.profiles: ${a.error}`] : [])),
        machines: machines().length,
      };
    },
    /** Свести репозитории профилей на всех машинах; итог — тостом. */
    async syncAll() {
      await Promise.all(machines().map((m) => load(m, true)));
      const cf = rowsOf(store.get().answers).flatMap((r) => r.cf.map((x) => `${short(r.id)} ${mLabel(x.m)}`));
      app.toast(cf.length ? `Сведено. Конфликт: ${cf.join(", ")}` : "Сведено", cf.length ? "bad" : "ok");
    },
  };
}
