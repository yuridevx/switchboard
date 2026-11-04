// Экран профилей: поиск, конфликты первыми, «Синхронизировать» — свести на всех машинах.
import { useEffect, useState } from "react";
import { Btn, In, profileName, useApp } from "@switchboard/web-ui";
import { ProfileRow } from "./ProfileRow.tsx";
import { useProfiles } from "./store.ts";

export function ProfilesScreen() {
  const app = useApp();
  const profiles = useProfiles();
  const { rows, repos, errors, machines } = app.use(profiles.summary);
  const [query, setQuery] = useState("");
  const [wantConflicts, setWantConflicts] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);

  useEffect(() => profiles.mount(), [profiles]);

  async function syncAll() {
    setSyncing(true);
    const r = await profiles.syncAll();
    app.toast(r.ok ? r.result : r.error, r.ok ? "ok" : "bad");
    setSyncing(false);
  }

  const needle = query.trim().toLowerCase();
  const conflicted = rows.filter((r) => r.conflicts.length).length;
  // конфликтов не осталось — фильтра нет; появились снова — фильтр вернулся
  const onlyConflicts = wantConflicts && conflicted > 0;
  const shown = rows
    .filter((r) => (!needle || `${r.id} ${r.about}`.toLowerCase().includes(needle)) && (!onlyConflicts || r.conflicts.length))
    .sort((a, b) => (b.conflicts.length ? 1 : 0) - (a.conflicts.length ? 1 : 0) || profileName(a.id).localeCompare(profileName(b.id)));
  return (
    <div className={"pf" + (app.wide ? " wide" : "")}>
      <div className="pf-h">
        {app.wide ? <b>Профили</b> : null}
        <span className="pf-repo">{repos.join(", ")}</span>
        <Btn data-act="sync" disabled={syncing} onClick={() => void syncAll()}>
          {syncing ? "Свожу…" : "Синхронизировать"}
        </Btn>
      </div>
      <div className="pf-b">
        <div className="pf-t">
          <In data-f="q" value={query} placeholder={`Найти профиль · ${rows.length}`} autoComplete="off" aria-label="Найти профиль" onInput={(e) => setQuery(e.currentTarget.value)} />
          {conflicted ? (
            <Btn data-act="conflicts" aria-pressed={onlyConflicts} onClick={() => setWantConflicts(!onlyConflicts)}>
              {`конфликты ${conflicted}`}
            </Btn>
          ) : null}
        </div>
        {errors.map((e) => (
          <div key={e} className="pf-e" role="alert">
            {e}
          </div>
        ))}
        <div className="pf-l">
          {shown.length ? shown.map((r) => <ProfileRow key={r.id} row={r} machines={machines} open={expanded === r.id} toggle={() => setExpanded(expanded === r.id ? null : r.id)} />) : <div className="pf-none">профилей нет</div>}
        </div>
      </div>
    </div>
  );
}
