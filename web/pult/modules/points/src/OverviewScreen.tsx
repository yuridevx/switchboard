// Обзор реестра: машины не на связи, сессии в R2, «только в R2», занято в R2.
import { memo, useCallback, useEffect, useMemo } from "react";
import { ago, Btn, day, H4, hhmm, Note, Opts, Page, PageHead, plural, Sec, useApp } from "@switchboard/web-ui";
import type { Roster } from "@switchboard/web-core";
import { FireSection } from "./FireSection.tsx";
import { OnlySection } from "./OnlySection.tsx";
import { usePoints } from "./store.ts";
import type { Fleet, FleetSession } from "./store.ts";
import { mb, r2Of, refusal } from "./words.ts";

/** Строка сессии в R2: имя — своей выборкой, правка имени перерисует только её. */
const SessionRow = memo(function SessionRow({ s, save }: { s: FleetSession; save(callsign: string): Promise<void> }) {
  const app = useApp();
  const label = app.use(() => app.mark("label.session", s.callsign ?? ""));
  const canSave = app.use(() => !!app.can(s.owner, "points.save"));
  return (
    <div className="pt-row" data-sid={s.sid}>
      <span>
        <b>{label?.text ?? s.callsign}</b>
        {` ${ago(s.head.at)} · №${s.head.id}`}
      </span>
      {canSave ? <Btn onClick={() => void save(s.callsign!)}>Сохранить сейчас</Btn> : null}
    </div>
  );
});

/** Раскладка реестра: хозяин пропал, сессия живёт на машине, осталась только в R2. */
function sortFleet(fleet: Fleet | null, roster: Roster | null) {
  const online = new Set((roster?.machines ?? []).map((m) => m.machine));
  const live = new Set((roster?.sessions ?? []).map((s) => s.callsign));
  const lost = new Map<string, FleetSession[]>();
  const only: FleetSession[] = [];
  const running: FleetSession[] = [];
  for (const s of fleet?.sessions ?? []) {
    if (!online.has(s.owner)) lost.set(s.owner, [...(lost.get(s.owner) ?? []), s]);
    else if (s.callsign && live.has(s.callsign)) running.push(s);
    else only.push(s);
  }
  return { fires: [...lost], only, running: running.sort((a, b) => a.head.at - b.head.at) };
}

export function OverviewScreen() {
  const app = useApp();
  const points = usePoints();
  const fleet = app.use(points.fleet);
  const refused = app.use(points.refused);
  const roster = app.use(() => app.roster());
  useEffect(() => void points.loadFleet(), [points]);
  const { fires, only, running } = useMemo(() => sortFleet(fleet, roster), [fleet, roster]);

  const save = useCallback(
    async (callsign: string) => {
      const r = await points.save(callsign);
      if (!r.ok) return app.toast(`${callsign}: ${refusal(r.error, callsign)}`, "bad");
      app.toast(`${callsign}: точка №${r.result.point}${r.result.same ? " — та же" : ""}`, "ok");
      await points.loadFleet();
    },
    [app, points],
  );

  const alert = refused ? (
    <Note tone="bad" role="alert">
      {`points.list: ${refused}`}
    </Note>
  ) : null;
  if (!fleet) {
    return (
      <Page>
        <PageHead title="Точки" />
        {alert ?? <Note>…</Note>}
      </Page>
    );
  }

  const sessions = roster?.sessions ?? [];
  const unmarked = sessions.filter((s) => !r2Of(s)).map((s) => s.callsign);
  return (
    <Page>
      <PageHead title="Точки" />
      {alert}
      <FireSection fires={fires} />
      <Opts data-summary="">
        <b>{`${running.length} ${plural(running.length, "сессия", "сессии", "сессий")} в R2 из ${sessions.length} на машинах`}</b>
        {fires.map(([m, list]) => (
          <Note key={m} tone="bad">{`· ${list.length} на ${m} — нет связи`}</Note>
        ))}
        <Note>{`· ${only.length} только в R2`}</Note>
      </Opts>
      <Sec>
        <H4>Последняя точка</H4>
        {running.map((s) => (
          <SessionRow key={s.sid} s={s} save={save} />
        ))}
        {running.length ? null : <Note>Сессий в R2 на связи нет.</Note>}
      </Sec>
      {unmarked.length ? <Note>{`${unmarked.join(", ")} не в R2`}</Note> : null}
      <OnlySection only={only} />
      <Note>
        {`В R2 ${mb(fleet.r2.bytes)}`}
        {fleet.sweep ? ` · уборка ${day(fleet.sweep.at)} ${hhmm(fleet.sweep.at)} — удалено ${fleet.sweep.blocks} блоков, ${mb(fleet.sweep.bytes)}` : ""}
      </Note>
    </Page>
  );
}
