// Экран профилей: поиск, конфликты первыми, «Синхронизировать» — свести на всех машинах.
import { useEffect, useState } from "react";
import { Btn, profileName as short, useApp, In } from "@switchboard/web-ui";
import { useProfiles } from "./store.ts";
import { ProfileRow } from "./ProfileRow.tsx";

export function ProfilesScreen() {
  const app = useApp();
  const profiles = useProfiles();
  const { all, repos, errors, machines } = app.use(profiles.summary);
  const [q, setQ] = useState("");
  const [wantCf, setOnlyCf] = useState(false);
  const [exp, setExp] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);

  useEffect(() => profiles.mount(), [profiles]);

  async function syncAll() {
    setSyncing(true);
    const r = await profiles.syncAll();
    app.toast(r.ok ? r.result : r.error, r.ok ? "ok" : "bad");
    setSyncing(false);
  }

  const ql = q.trim().toLowerCase();
  const ncf = all.filter((r) => r.cf.length).length;
  // конфликтов не осталось — фильтра нет; появились снова — фильтр вернулся
  const onlyCf = wantCf && ncf > 0;
  const shown = all
    .filter((r) => (!ql || `${r.id} ${r.about}`.toLowerCase().includes(ql)) && (!onlyCf || r.cf.length))
    .sort((a, b) => (b.cf.length ? 1 : 0) - (a.cf.length ? 1 : 0) || short(a.id).localeCompare(short(b.id)));
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
          <In data-f="q" value={q} placeholder={`Найти профиль · ${all.length}`} autoComplete="off" aria-label="Найти профиль" onInput={(e) => setQ(e.currentTarget.value)} />
          {ncf ? (
            <Btn data-act="conflicts" aria-pressed={onlyCf} onClick={() => setOnlyCf(!onlyCf)}>
              {`конфликты ${ncf}`}
            </Btn>
          ) : null}
        </div>
        {errors.map((e) => (
          <div key={e} className="pf-e" role="alert">
            {e}
          </div>
        ))}
        <div className="pf-l">
          {shown.length ? shown.map((r) => <ProfileRow key={r.id} r={r} machines={machines} open={exp === r.id} toggle={(id) => setExp((old) => (old === id ? null : id))} />) : <div className="pf-none">профилей нет</div>}
        </div>
      </div>
    </div>
  );
}
