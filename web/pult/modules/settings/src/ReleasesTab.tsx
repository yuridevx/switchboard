// Вкладка «Выпуски»: по машинам (stable флота, отмеченные, матрица и план машины) или каталог и сборки.
import { Btn, M, Meter, Note, plural, Sec, useApp } from "@switchboard/web-ui";
import { Catalog } from "./Catalog.tsx";
import { useSettings } from "./store.ts";
import { MachinePlan } from "./MachinePlan.tsx";
import { Matrix } from "./Matrix.tsx";
import { NoteOf } from "./parts.tsx";
import { cellOf, prevBuild, short, stableOf, versionsOf } from "./rules.ts";
import type { State } from "./store.ts";

/** Stable частей машин и сколько машин на связи его держат. */
function Roll() {
  const app = useApp();
  const settings = useSettings();
  const d = app.use(settings.releaseData);
  const busy = app.use(() => settings.get().busy);
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
      <NoteOf k="deploy" />
    </Sec>
  );
}

/** Отмеченные машины: закрепить host разом или вернуть к stable. */
function Bulk() {
  const app = useApp();
  const settings = useSettings();
  const d = app.use(settings.releaseData);
  const selected = Object.keys(app.use(() => settings.get().rsel));
  if (!selected.length) return null;
  const stable = stableOf(d, "host");
  const vs = versionsOf(d, "host", 3).filter((v) => v !== stable);
  return (
    <div className="st-bulk" data-bulk="">
      <b>{`Выбрано ${selected.length}`}</b>
      <Note>{selected.map((m) => `@${m}`).join(", ")}</Note>
      <span className="st-grow" />
      {vs.map((v) => (
        <Btn key={v} onClick={() => void settings.bulk(v)}>
          {`host: закрепить ${short(v)}`}
        </Btn>
      ))}
      <Btn onClick={() => void settings.bulk(null)}>host: к stable</Btn>
      <Btn onClick={settings.clearSelected}>Снять</Btn>
    </div>
  );
}

function SubTab({ k, label, cur }: { k: State["rtab"]; label: string; cur: State["rtab"] }) {
  const settings = useSettings();
  return (
    <Btn aria-pressed={cur === k ? "true" : "false"} onClick={() => settings.setReleasesTab(k)}>
      {label}
    </Btn>
  );
}

export function Releases() {
  const app = useApp();
  const settings = useSettings();
  const list = app.use(() => settings.get().list);
  const rtab = app.use(() => settings.get().rtab);
  const rm = app.use(() => settings.get().rm);
  if (!app.worker("releases")) return <Note>«Выпусков» во флоте нет</Note>;
  return (
    <>
      <div className="st-tabs">
        <SubTab k="machines" label="По машинам" cur={rtab} />
        <SubTab k="catalog" label="Каталог и сборки" cur={rtab} />
      </div>
      {list && "error" in list ? (
        <Note tone="bad" role="alert">{`releases.list: ${list.error}`}</Note>
      ) : !list ? (
        <Note>…</Note>
      ) : rtab === "catalog" ? (
        <Catalog list={list} />
      ) : (
        <>
          <Roll />
          <Bulk />
          <div className="st-grid">
            <Matrix />
            {rm ? <MachinePlan key={rm} m={rm} /> : <span />}
          </div>
        </>
      )}
    </>
  );
}
