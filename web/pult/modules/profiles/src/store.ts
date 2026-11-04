// Состояние профилей: ответы machine.profiles всех машин, сведённые в строки по id. Конфликт — состояние репозитория профиля на машине.
import type { App, Roster } from "@switchboard/web-core";
import { machineOf } from "@switchboard/protocol";
import { folderOf, lamp, type MachineAnswer, machineAnswers, type MachineAnswers, machineLabel, profileIdOf, profileName as short, sessionLabel, useModule, machinesWith, okOf } from "@switchboard/web-ui";

type Repo = { state: "ok" | "error" | "conflict"; files?: string[]; error?: string };
type Answer = { profiles: Record<string, { model?: string | null; effort?: string | null; about?: string }>; repos: Record<string, Repo> };

const repoOf = (id: string) => id.slice(0, id.lastIndexOf("/"));

/** Строки: id → машины, описание и модель первой ответившей, машины с конфликтом. */
function rowsOf(answers: Readonly<Record<string, MachineAnswer<Answer>>>) {
  const out = new Map<string, { id: string; about: string; model: string; effort: string; ms: string[]; cf: Array<{ m: string; repo: Repo }> }>();
  for (const [m, a] of Object.entries(answers)) {
    const ok = okOf(a);
    if (!ok) continue;
    for (const [id, p] of Object.entries(ok.profiles)) {
      const row = out.get(id) ?? { id, about: p.about ?? "", model: p.model ?? "", effort: p.effort ?? "", ms: [], cf: [] };
      row.ms.push(m);
      out.set(id, row);
      const repo = ok.repos[repoOf(id)];
      if (!repo || repo.state === "ok") continue;
      // файлы конфликта — под папками профилей: конфликт у того, чьи файлы; ни под чьей — у всех профилей репозитория
      const files = repo.files ?? [];
      const own = files.filter((f) => f.startsWith(`${short(id)}/`));
      const anyone = files.some((f) => Object.keys(ok.profiles).some((x) => f.startsWith(`${short(x)}/`)));
      if (own.length || !anyone) row.cf.push({ m, repo: { ...repo, files: own.length ? own : files } });
    }
  }
  return [...out.values()];
}

export type ProfilesStore = ReturnType<typeof createProfilesStore>;
/** Стор модуля в экранах. */
export const useProfiles = (): ProfilesStore => useModule<ProfilesStore>();
export type ProfileRowData = ReturnType<ProfilesStore["summary"]>["all"][number];

export function createProfilesStore(app: App) {
  const machines = () => machinesWith(app, "machine.profiles");
  const mLabel = (m: string) => machineLabel(app, m).text;
  const replies: MachineAnswers<Answer> = machineAnswers<Answer>(app, (m) => app.request<Answer>("machine.profiles", { machine: m }), machines);

  return {
    /** Машина пришла или вернулась при открытом экране — спросить и её. */
    onRoster: (r: Roster) => replies.onRoster(r),
    /** Экран открыт: спросить машины; возврат — экран закрыт. */
    mount: () => replies.mount(),
    /** Всё, что показывает экран: простые данные, сравниваются по содержимому. */
    summary() {
      const sessions = app.roster()?.sessions ?? [];
      const answers = replies.get();
      const list = Object.values(answers);
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
        repos: [...new Set(list.flatMap((a) => Object.keys(okOf(a)?.repos ?? {})))],
        errors: Object.entries(answers).flatMap(([m, a]) => ("error" in a ? [`${mLabel(m)}: machine.profiles: ${a.error}`] : [])),
        machines: machines().length,
      };
    },
    /** Свести репозитории профилей на всех машинах; итог — тостом. */
    async syncAll() {
      await Promise.all(machines().map((m) => replies.reload(m, (x) => app.request<Answer>("machine.profiles", { machine: x, sync: true }))));
      const cf = rowsOf(replies.get()).flatMap((r) => r.cf.map((x) => `${short(r.id)} ${mLabel(x.m)}`));
      app.toast(cf.length ? `Сведено. Конфликт: ${cf.join(", ")}` : "Сведено", cf.length ? "bad" : "ok");
    },
  };
}
