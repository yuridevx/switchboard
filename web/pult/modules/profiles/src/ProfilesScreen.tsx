// Профили всех машин: строка на профиль, с конфликтом — сверху; раскрывается в машины, сессии и файлы конфликта.
import { useEffect, useState } from "react";
import { Btn, Dot, effortName, folderOf, In, lamp, machineLabel, type MachineAnswers, machinesWith, okOf, plural, profileIdOf, type ProfileInfo, type ProfileRepo, type ProfilesAnswer, sessionLabel, useApp, useModule, wordOf } from "@switchboard/web-ui";
import type { SessionRecord } from "@switchboard/relay";

type Trouble = { machine: string; repo: ProfileRepo };
type Row = { id: string; repo: string; folder: string; info: ProfileInfo; machines: string[]; troubles: Trouble[] };

/** Файлы конфликта под папкой профиля — только его; ни под чьей или ошибка — всех профилей репозитория. */
function troubleOf(repo: ProfileRepo, folder: string, folders: string[]): boolean {
  if (repo.state === "ok") return false;
  const files = repo.files ?? [];
  const owned = files.filter((f) => folders.some((p) => f.startsWith(`${p}/`)));
  return !owned.length || owned.some((f) => f.startsWith(`${folder}/`));
}

function rowsOf(answers: Readonly<Record<string, unknown>>): Row[] {
  const rows = new Map<string, Row>();
  const list = Object.entries(answers as Record<string, Parameters<typeof okOf<ProfilesAnswer>>[0]>);
  for (const [machine, a] of list) {
    for (const [id, info] of Object.entries(okOf(a)?.profiles ?? {})) {
      const parts = id.split("/");
      const row = rows.get(id) ?? { id, repo: parts.slice(0, 2).join("/"), folder: parts.slice(2).join("/"), info, machines: [], troubles: [] };
      row.machines.push(machine);
      rows.set(id, row);
    }
  }
  const all = [...rows.values()];
  for (const [machine, a] of list) {
    for (const [name, repo] of Object.entries(okOf(a)?.repos ?? {})) {
      const peers = all.filter((r) => r.repo === name);
      for (const r of peers) if (r.machines.includes(machine) && troubleOf(repo, r.folder, peers.map((p) => p.folder))) r.troubles.push({ machine, repo });
    }
  }
  return all.sort((a, b) => Number(!!b.troubles.length) - Number(!!a.troubles.length));
}

export function ProfilesScreen() {
  const app = useApp();
  const answers = useModule<MachineAnswers<ProfilesAnswer>>();
  const data = app.use(() => answers.get());
  const machines = app.use(() => machinesWith(app, "machine.profiles"));
  const [q, setQ] = useState("");
  const [onlyConflicts, setOnlyConflicts] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  useEffect(() => answers.mount(), [answers]);

  const rows = rowsOf(data);
  const conflicts = rows.filter((r) => r.troubles.length);
  const active = onlyConflicts && conflicts.length > 0;
  const needle = q.trim().toLowerCase();
  const shown = (active ? conflicts : rows).filter((r) => !needle || `${r.id} ${r.info.about ?? ""}`.toLowerCase().includes(needle));
  const repos = [...new Set(Object.values(data).flatMap((a) => Object.keys(okOf(a)?.repos ?? {})))];

  async function sync() {
    setSyncing(true);
    await Promise.all(machines.map((m) => answers.reload(m, (machine) => app.request<ProfilesAnswer>("machine.profiles", { machine, sync: true }))));
    setSyncing(false);
    const after = rowsOf(answers.get());
    const bad = after.flatMap((r) => r.troubles.map((t) => `${r.folder} @${t.machine}`));
    app.toast(bad.length ? `Сведено. Конфликт: ${bad.join(", ")}` : "Сведено");
  }

  return (
    <div className={app.wide ? "pf wide" : "pf"}>
      <div className="pf-h">
        <b>Профили</b>
        <span className="pf-repo">{repos.join(", ")}</span>
        <Btn data-act="sync" disabled={syncing} onClick={() => void sync()}>
          {syncing ? "Свожу…" : "Синхронизировать"}
        </Btn>
      </div>
      <div className="pf-b">
        <div className="pf-t">
          <In data-f="q" placeholder={`Найти профиль · ${rows.length}`} autoComplete="off" aria-label="Найти профиль" value={q} onInput={(e) => setQ(e.currentTarget.value)} />
          {conflicts.length ? (
            <Btn data-act="conflicts" aria-pressed={onlyConflicts ? "true" : "false"} onClick={() => setOnlyConflicts(!onlyConflicts)}>
              {`конфликты ${conflicts.length}`}
            </Btn>
          ) : null}
        </div>
        {Object.entries(data).map(([m, a]) =>
          wordOf(a) ? (
            <div key={m} className="pf-e">
              {`@${m}: machine.profiles: ${wordOf(a)}`}
            </div>
          ) : null,
        )}
        <div className="pf-l">
          {shown.length ? shown.map((r) => <ProfileRow key={r.id} row={r} total={machines.length} open={open === r.id} toggle={() => setOpen(open === r.id ? null : r.id)} />) : <div className="pf-none">профилей нет</div>}
        </div>
      </div>
    </div>
  );
}

function ProfileRow({ row, total, open, toggle }: { row: Row; total: number; open: boolean; toggle(): void }) {
  const app = useApp();
  const sessions = app.use(() => (app.roster()?.sessions ?? []).filter((s: SessionRecord) => profileIdOf(s) === row.id));
  const line = [row.info.model, row.info.effort ? effortName(row.info.effort) : null].filter(Boolean).join(" · ");
  const bad = (m: string) => row.troubles.some((t) => t.machine === m);
  return (
    <div className={row.troubles.length ? "pf-w cf" : "pf-w"} data-profile={row.id}>
      <button type="button" className="pf-r" aria-expanded={open} onClick={toggle}>
        <span className="pf-n">
          <b>{row.folder}</b>
          {row.info.about ? <span>{row.info.about}</span> : null}
        </span>
        <span className="pf-m">
          {line ? <span>{line}</span> : null}
          <span className="c">{`${row.machines.length}/${total} машин · ${sessions.length} ${plural(sessions.length, "сессия", "сессии", "сессий")}`}</span>
          {row.troubles.length ? <span className="pf-p bad">{`конфликт ${row.troubles.map((t) => `@${t.machine}`).join(", ")}`}</span> : null}
        </span>
      </button>
      {open ? (
        <div className="pf-d">
          <div className="pf-ms">
            {row.machines.map((m) => (
              <span key={m} className={bad(m) ? "pf-p bad" : "pf-p ok"}>
                {bad(m) ? `@${m} конфликт` : `@${m}`}
              </span>
            ))}
          </div>
          {sessions.length ? (
            <div className="pf-ss">
              {sessions.map((s) => {
                const name = sessionLabel(app, s.callsign);
                return (
                  <button key={s.callsign} type="button" data-callsign={s.callsign} onClick={() => app.open("card", { callsign: s.callsign })}>
                    <Dot kind={lamp(s)} />
                    <span className={name.human ? "nm hum" : "nm"}>{name.text}</span>
                    <span className="k">{`${machineLabel(app, s.callsign.split("@")[1]).text} · ${folderOf(s.dir)}`}</span>
                  </button>
                );
              })}
            </div>
          ) : null}
          {row.troubles.map((t) => (
            <div key={t.machine} className="pf-cf">
              <b>{`@${t.machine}: ${t.repo.state === "conflict" ? "конфликт" : "ошибка"}`}</b>
              {t.repo.error ? <span>{t.repo.error}</span> : null}
              {t.repo.files?.map((f) => (
                <code key={f}>{f}</code>
              ))}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
