// Обзор реестра: «пожар», сессии в R2 на связи, «только в R2», занято в R2.
import { memo, useEffect, useMemo } from "react";
import { useApp } from "@switchboard/web-core";
import { Btn, H4, hhmm, Note, Opts, Page, PageHead, plural, Sec } from "@switchboard/web-ui";
import { usePoints } from "./context.ts";
import { FireSection } from "./FireSection.tsx";
import { ago, day, mb, r2Of, say } from "./format.ts";
import { OnlySection } from "./OnlySection.tsx";
import type { FleetSession } from "./store.ts";

/** Строка сессии в R2: имя — своей выборкой, правка имени перерисует только её. */
const R2Row = memo(function R2Row({ s, save }: { s: FleetSession; save(callsign: string): void }) {
  const app = useApp();
  const label = app.use(() => app.mark("label.session", s.callsign ?? ""));
  const canSave = app.use(() => !!app.can(s.owner, "points.save"));
  return (
    <div className="pt-row" data-sid={s.sid}>
      <span>
        <b>{label?.text ?? s.callsign}</b>
        {` ${ago(s.head.at)} · №${s.head.id}`}
      </span>
      {canSave ? <Btn onClick={() => save(s.callsign!)}>Сохранить сейчас</Btn> : null}
    </div>
  );
});

function PageTitle() {
  return (
    <PageHead title="Точки">
      <Note>сохранённые состояния сессий — из них сессию поднимают на любой машине</Note>
    </PageHead>
  );
}

export function OverviewScreen() {
  const app = useApp();
  const points = usePoints();
  const fleet = app.use(points.fleet);
  const refused = app.use(points.fleetRefused);
  const left = app.use(points.left);
  const roster = app.use(() => app.roster());

  useEffect(() => void points.loadFleet(), [points]);

  async function save(callsign: string) {
    const r = await points.savePoint(callsign);
    app.toast(r.ok ? `${callsign}: точка №${r.result.point}${r.result.same ? " — та же" : ""}` : `${callsign}: ${say(r.error, callsign)}`, r.ok ? "ok" : "bad");
    if (r.ok) await points.loadFleet();
  }

  // раскладка реестра: хозяин пропал, сессия живёт на машине, осталась только в R2
  const { fires, only, inR2 } = useMemo(() => {
    const on = new Set((roster?.machines ?? []).map((m) => m.machine));
    const live = new Set((roster?.sessions ?? []).map((s) => s.callsign));
    const byOwner = new Map<string, FleetSession[]>();
    const only: FleetSession[] = [];
    const inR2: FleetSession[] = [];
    for (const s of fleet?.sessions ?? []) {
      if (!on.has(s.owner)) byOwner.set(s.owner, [...(byOwner.get(s.owner) ?? []), s]);
      else if (s.callsign && live.has(s.callsign)) inR2.push(s);
      else only.push(s);
    }
    inR2.sort((a, b) => a.head.at - b.head.at);
    return { fires: [...byOwner], only, inR2 };
  }, [fleet, roster]);

  const refusal = refused ? (
    <Note tone="bad" role="alert">
      {`points.list: ${refused}`}
    </Note>
  ) : null;
  if (!fleet) {
    return (
      <Page>
        <PageTitle />
        {refusal}
        {refused ? null : <Note>…</Note>}
      </Page>
    );
  }

  const total = roster?.sessions.length ?? 0;
  const outside = (roster?.sessions ?? []).filter((s) => !r2Of(s)).map((s) => s.callsign);
  return (
    <Page>
      <PageTitle />
      {refusal}
      <FireSection fires={fires} left={left} />
      <Opts data-summary="">
        <b>{`${inR2.length} ${plural(inR2.length, "сессия", "сессии", "сессий")} в R2 из ${total} на машинах`}</b>
        {fires.map(([m, l]) => (
          <Note key={m} tone="bad">{`· ${l.length} на ${m} — нет связи`}</Note>
        ))}
        <Note>{`· ${only.length} только в R2`}</Note>
      </Opts>
      <Sec>
        <H4>Последняя точка — давнее всех сверху</H4>
        {inR2.map((s) => (
          <R2Row key={s.sid} s={s} save={(c) => void save(c)} />
        ))}
        {inR2.length ? null : <Note>Сессий в R2 на связи нет.</Note>}
      </Sec>
      {outside.length ? <Note>{`${outside.join(", ")} не в R2 — точек и переноса у них нет; включить — вкладка «Точки» сессии.`}</Note> : null}
      <OnlySection only={only} />
      <Note>
        {`В R2 ${mb(fleet.r2.bytes)}`}
        {fleet.sweep ? ` · уборка ${day(fleet.sweep.at)} ${hhmm(fleet.sweep.at)} — удалено ${fleet.sweep.blocks} блоков, ${mb(fleet.sweep.bytes)}` : ""}
      </Note>
    </Page>
  );
}
