// Каталог и сборки: части со stable и историей, модули сборок; «Выложить» и «Вернуть».
import { Btn, M, Note, Opts, Outcome, Sec, useApp } from "@switchboard/web-ui";
import { cmpV, short, type Listed } from "./rules.ts";
import { useSettings } from "./state.ts";

function PartRow({ p, x, busy }: { p: string; x: Listed["parts"][string]; busy: string }) {
  const settings = useSettings();
  // прежние номера — история части: вернуть можно любой из них
  const older = (x.versions ?? []).filter((v) => x.stable && cmpV(v, x.stable) < 0).reverse().slice(0, 3);
  return (
    <tr data-part={p}>
      <td>
        <M>{p}</M>
      </td>
      <td>{x.where === "cloud" ? "Cloudflare" : "машины"}</td>
      <td>
        <M>{x.stable ?? "—"}</M>
      </td>
      <td>
        <Note>
          <M>{(x.versions ?? []).slice(-4).map(short).join(" · ")}</M>
        </Note>
      </td>
      <td>
        <Opts>
          {x.edge && x.edge !== x.stable ? (
            <Btn pri disabled={busy !== ""} onClick={() => void settings.deploy(p, x.edge!)}>
              {busy === p ? "Выкладываю…" : `Выложить ${short(x.edge)}`}
            </Btn>
          ) : null}
          {older.map((v) => (
            <Btn key={v} data-back={v} disabled={busy !== ""} onClick={() => void settings.deploy(p, v)}>
              {`Вернуть ${short(v)}`}
            </Btn>
          ))}
        </Opts>
      </td>
    </tr>
  );
}

function ModuleRow({ n, x, busy }: { n: string; x: NonNullable<Listed["modules"]>[string]; busy: string }) {
  const settings = useSettings();
  const fresh = !!x.edge && Object.values(x.built).some((v) => cmpV(x.edge!, v) > 0);
  return (
    <tr data-module={n}>
      <td>
        <M>{n}</M>
      </td>
      <td>{x.into.join(", ")}</td>
      <td>
        <M>{Object.entries(x.built).map(([a, v]) => `${a} ${v}`).join(" · ") || "—"}</M>
      </td>
      <td>
        <M>{fresh ? x.edge : ""}</M>
      </td>
      <td>
        {fresh ? (
          <Btn pri disabled={busy !== ""} onClick={() => void settings.deploy(n, x.edge!)}>
            {busy === n ? "Выкладываю…" : `Выложить ${x.edge}`}
          </Btn>
        ) : null}
      </td>
    </tr>
  );
}

export function Catalog({ list }: { list: Listed }) {
  const app = useApp();
  const settings = useSettings();
  const busy = app.use(() => settings.get().busy);
  const deployed = app.use(() => settings.get().deployed);
  const byName = <T,>(o: Record<string, T>) => Object.entries(o).sort(([a], [b]) => a.localeCompare(b));
  return (
    <div className="st-cat">
      <Sec>
        <b>Части</b>
        <table className="st-tbl">
          <thead>
            <tr>
              <th>часть</th>
              <th>где</th>
              <th>stable</th>
              <th>история</th>
              <th className="st-w30"></th>
            </tr>
          </thead>
          <tbody>
            {byName(list.parts).map(([p, x]) => (
              <PartRow key={p} p={p} x={x} busy={busy} />
            ))}
          </tbody>
        </table>
      </Sec>
      <Sec>
        <b>Модули сборок</b>
        <table className="st-tbl">
          <thead>
            <tr>
              <th>модуль</th>
              <th>входит в</th>
              <th>в сборке</th>
              <th>новее</th>
              <th className="st-w20"></th>
            </tr>
          </thead>
          <tbody>
            {byName(list.modules ?? {}).map(([n, x]) => (
              <ModuleRow key={n} n={n} x={x} busy={busy} />
            ))}
          </tbody>
        </table>
      </Sec>
      <Outcome note={deployed} />
    </div>
  );
}
