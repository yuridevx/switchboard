// Вкладка «Выпуски»: по машинам (stable флота, отмеченные, матрица и план машины) или каталог и сборки.
import { useCallback, useEffect, useState } from "react";
import { Btn, M, Meter, Note, Outcome, plural, type Result, Sec, useApp, useOutcome } from "@switchboard/web-ui";
import { Catalog } from "./catalog.tsx";
import { useCatalog } from "./load.ts";
import { Matrix } from "./matrix.tsx";
import { MachinePlan } from "./plan.tsx";
import { cellOf, type Listed, prevBuild, short, stableOf, versionsOf } from "./rules.ts";
import { useSettings, type State } from "./state.ts";

/** Stable частей машин и сколько машин на связи его держат. */
function Roll({ list }: { list: Listed }) {
  const app = useApp();
  const settings = useSettings();
  const d = app.use(() => settings.releaseData(list));
  const busy = app.use(() => settings.get().busy);
  const deployed = app.use(() => settings.get().deployed);
  return (
    <Sec>
      <b>Stable флота</b>
      {["host", "keeper"]
        .filter((p) => stableOf(d, p))
        .map((p) => {
          const n = d.online.filter((m) => cellOf(d, m, p)?.k === "ok").length;
          const back = prevBuild(stableOf(d, p));
          return (
            <div key={p} className="st-roll" data-roll={p}>
              <span className="st-grow">
                <b>{p}</b> <M>{stableOf(d, p)}</M>
              </span>
              <Meter className="st-bar" value={d.online.length ? Math.round((n / d.online.length) * 100) : 0} warn={n < d.online.length} />
              <Note>{`${n} из ${d.online.length} ${plural(d.online.length, "машины", "машин", "машин")}`}</Note>
              {back ? (
                <Btn disabled={busy !== ""} onClick={() => void settings.deploy(p, back)}>
                  {`Вернуть ${short(back)}`}
                </Btn>
              ) : null}
            </div>
          );
        })}
      <Outcome note={deployed} />
    </Sec>
  );
}

/** Отмеченные машины: закрепить host разом или вернуть к stable. */
function Bulk({ list, done }: { list: Listed; done(r: Result<string>): void }) {
  const app = useApp();
  const settings = useSettings();
  const d = app.use(() => settings.releaseData(list));
  const selected = Object.keys(app.use(() => settings.get().rsel));
  if (!selected.length) return null;
  return (
    <div className="st-bulk" data-bulk="">
      <b>{`Выбрано ${selected.length}`}</b>
      <Note>{selected.map((m) => `@${m}`).join(", ")}</Note>
      <span className="st-grow" />
      {versionsOf(d, "host", 3).map((v) => (
        <Btn key={v} onClick={() => void settings.bulk(v).then(done)}>
          {`host: закрепить ${short(v)}`}
        </Btn>
      ))}
      <Btn onClick={() => void settings.bulk(null).then(done)}>host: к stable</Btn>
      <Btn onClick={settings.clearSelected}>Снять</Btn>
    </div>
  );
}

const SUBTABS: Array<[State["rtab"], string]> = [["machines", "По машинам"], ["catalog", "Каталог и сборки"]];

function ReleasesBody({ machine }: { machine?: string }) {
  const app = useApp();
  const settings = useSettings();
  const { data: list, error, reload } = useCatalog();
  useEffect(() => settings.mountKeeper(), [settings]);
  const rtab = app.use(() => settings.get().rtab);
  // машина из адреса — выбрана при открытии: новые параметры адреса открывают экран заново
  const [picked, pick] = useState<string | null>(machine ?? null);
  const [notes, say] = useOutcome();
  const done = useCallback(
    (r: Result<string>) => {
      if (r.ok) app.toast(r.result, "ok");
      else say("plan", r.error, "bad");
      reload();
    },
    [app, say, reload],
  );
  return (
    <>
      <div className="st-tabs">
        {SUBTABS.map(([k, label]) => (
          <Btn key={k} aria-pressed={rtab === k ? "true" : "false"} onClick={() => settings.setReleasesTab(k)}>
            {label}
          </Btn>
        ))}
      </div>
      {error ? <Note tone="bad" role="alert">{`releases.list: ${error}`}</Note> : null}
      {!list && !error ? (
        <Note>…</Note>
      ) : rtab === "catalog" ? (
        list ? <Catalog list={list} /> : null
      ) : (
        <>
          {list ? <Roll list={list} /> : null}
          {list ? <Bulk list={list} done={done} /> : null}
          <div className="st-grid">
            <Matrix list={list ?? null} picked={picked} pick={pick} />
            {picked ? <MachinePlan key={picked} list={list ?? null} m={picked} close={() => pick(null)} note={notes.plan} done={done} /> : <span />}
          </div>
        </>
      )}
    </>
  );
}

export function Releases({ machine }: { machine?: string }) {
  const app = useApp();
  return app.worker("releases") ? <ReleasesBody machine={machine} /> : <Note>«Выпусков» во флоте нет</Note>;
}
