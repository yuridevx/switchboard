// Ответы machine.profiles всех машин, сведённые в строки по id. Конфликт — состояние репозитория профиля на машине.
import { machineOf } from "@switchboard/protocol";
import type { App } from "@switchboard/web-core";
import { folderOf, lamp, machineAnswers, machineLabel, machinesWith, okOf, type MachineAnswer, type ProfileRepo, type ProfilesAnswer, profileIdOf, profileName, sessionLabel, useModule } from "@switchboard/web-ui";

type Raw = { id: string; about: string; model: string; effort: string; machines: string[]; conflicts: Array<{ m: string; repo: ProfileRepo }> };

const repoOf = (id: string) => id.slice(0, id.lastIndexOf("/"));

/** Чей конфликт: файлы под папкой профиля — только у него; ни под чьей — у всех профилей репозитория. */
function conflictOf(id: string, repo: ProfileRepo, all: string[]): ProfileRepo | null {
  const files = repo.files ?? [];
  const under = (p: string) => files.filter((f) => f.startsWith(`${profileName(p)}/`));
  const own = under(id);
  if (own.length) return { ...repo, files: own };
  return all.some((p) => under(p).length) ? null : { ...repo, files };
}

function rowsOf(answers: Readonly<Record<string, MachineAnswer<ProfilesAnswer>>>): Raw[] {
  const rows = new Map<string, Raw>();
  for (const [m, answer] of Object.entries(answers)) {
    const ok = okOf(answer);
    if (!ok) continue;
    for (const [id, p] of Object.entries(ok.profiles)) {
      const row = rows.get(id) ?? { id, about: p.about ?? "", model: p.model ?? "", effort: p.effort ?? "", machines: [], conflicts: [] };
      rows.set(id, row);
      row.machines.push(m);
      const repo = ok.repos[repoOf(id)];
      if (!repo || repo.state === "ok") continue;
      const conflict = conflictOf(id, repo, Object.keys(ok.profiles));
      if (conflict) row.conflicts.push({ m, repo: conflict });
    }
  }
  return [...rows.values()];
}

export type ProfilesStore = ReturnType<typeof createProfilesStore>;
export const useProfiles = (): ProfilesStore => useModule<ProfilesStore>();
export type ProfileRowData = ReturnType<ProfilesStore["summary"]>["rows"][number];

export function createProfilesStore(app: App) {
  const machines = () => machinesWith(app, "machine.profiles");
  const label = (m: string) => machineLabel(app, m).text;
  const answers = machineAnswers<ProfilesAnswer>(app, (m) => app.read<ProfilesAnswer>("machine.profiles", { machine: m }), machines);

  return {
    /** Машина пришла или вернулась при открытом экране — спросить и её. */
    onLink: answers.onLink,
    /** Экран открыт: спросить машины; возврат — экран закрыт. */
    mount: () => answers.mount(),
    /** Всё, что показывает экран: простые данные, сравниваются по содержимому. */
    summary() {
      const sessions = app.roster()?.sessions ?? [];
      const all = answers.get();
      return {
        rows: rowsOf(all).map((r) => ({
          ...r,
          machines: r.machines.map((m) => ({ m, label: label(m) })),
          conflicts: r.conflicts.map((c) => ({ ...c, label: label(c.m) })),
          running: sessions
            .filter((s) => profileIdOf(s) === r.id)
            .map((s) => {
              const name = sessionLabel(app, s.callsign);
              return { callsign: s.callsign, lamp: lamp(s), text: name.text, human: name.human, place: `${label(machineOf(s.callsign) ?? "")} · ${folderOf(s.dir)}` };
            }),
        })),
        repos: [...new Set(Object.values(all).flatMap((a) => Object.keys(okOf(a)?.repos ?? {})))],
        errors: Object.entries(all).flatMap(([m, a]) => ("error" in a ? [`${label(m)}: machine.profiles: ${a.error}`] : [])),
        machines: machines().length,
      };
    },
    /** Свести репозитории профилей на всех машинах; конфликт — отказ словами. */
    async syncAll() {
      await Promise.all(machines().map((m) => answers.reload(m, (x) => app.request<ProfilesAnswer>("machine.profiles", { machine: x, sync: true }))));
      const conflicts = rowsOf(answers.get()).flatMap((r) => r.conflicts.map((c) => `${profileName(r.id)} ${label(c.m)}`));
      return conflicts.length ? ({ ok: false, error: `Сведено. Конфликт: ${conflicts.join(", ")}` } as const) : ({ ok: true, result: "Сведено" } as const);
    },
  };
}
