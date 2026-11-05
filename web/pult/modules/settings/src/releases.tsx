// «Выпуски»: stable по машинам, матрица машина × часть и план машины; каталог частей и модулей сборок.
import { useEffect, useState } from "react";
import { Btn, Dot, In, machineLabel, machinesWith, Meter, Note, okOf, Opts, Page as _Page, PageHead, plural, Sec, useApp, useLoad, useModule, wordOf } from "@switchboard/web-ui";
import { before, cellOf, short, wordText, type KPart, type Pass, type PlanEntry, type Releases } from "./rules.ts";
import type { SettingsState } from "./state.ts";

void _Page;
const KEEPER = "keeper";

function Catalog({ list, reload }: { list: Releases; reload(): void }) {
  const app = useApp();
  const st = useModule<SettingsState>();
  const { deploying } = app.use(() => st.get());
  const deploy = (part: string, version: string) => void st.deploy(part, version, reload);
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
              <th className="st-w30" />
            </tr>
          </thead>
          <tbody>
            {Object.entries(list.parts).map(([name, p]) => (
              <tr key={name} data-part={name}>
                <td>
                  <span className="sb-m">{name}</span>
                </td>
                <td>{p.where === "machine" ? "машины" : "Cloudflare"}</td>
                <td>
                  <span className="sb-m">{p.stable}</span>
                </td>
                <td>
                  <Note>
                    <span className="sb-m">{p.versions.map(short).join(" · ")}</span>
                  </Note>
                </td>
                <td>
                  <Opts>
                    {p.edge !== p.stable ? (
                      <Btn pri disabled={!!deploying} onClick={() => deploy(name, p.edge)}>
                        {deploying === `${name}:${p.edge}` ? "Выкладываю…" : `Выложить ${short(p.edge)}`}
                      </Btn>
                    ) : null}
                    {p.versions
                      .slice(0, Math.max(p.versions.indexOf(p.stable), 0))
                      .reverse()
                      .map((v) => (
                        <Btn key={v} data-back={v} disabled={!!deploying} onClick={() => deploy(name, v)}>
                          {deploying === `${name}:${v}` ? "Выкладываю…" : `Вернуть ${short(v)}`}
                        </Btn>
                      ))}
                  </Opts>
                </td>
              </tr>
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
              <th className="st-w20" />
            </tr>
          </thead>
          <tbody>
            {Object.entries(list.modules).map(([name, m]) => {
              const newer = Object.values(m.built).some((v) => v !== m.edge);
              return (
                <tr key={name} data-module={name}>
                  <td>
                    <span className="sb-m">{name}</span>
                  </td>
                  <td>{m.into.join(", ")}</td>
                  <td>
                    <span className="sb-m">{Object.entries(m.built).map(([app_, v]) => `${app_} ${v}`).join(" · ")}</span>
                  </td>
                  <td>{newer ? <span className="sb-m">{m.edge}</span> : null}</td>
                  <td>
                    {newer ? (
                      <Btn pri disabled={!!deploying} onClick={() => deploy(name, m.edge)}>
                        {deploying === `${name}:${m.edge}` ? "Выкладываю…" : `Выложить ${m.edge}`}
                      </Btn>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Sec>
    </div>
  );
}

function Plan({ machine, list, close, setPlan }: { machine: string; list?: Releases; close(): void; setPlan(part: string, change: { pin?: string | null; on?: boolean }): Promise<string> }) {
  const app = useApp();
  const st = useModule<SettingsState>();
  const answer = app.use(() => okOf(st.keeper.get()[machine]));
  const online = app.use(() => machinesWith(app).includes(machine));
  const label = app.use(() => machineLabel(app, machine).text);
  const [word, setWord] = useState("");
  const [typed, setTyped] = useState<Record<string, string>>({});
  const plan = list?.machines.find((m) => m.machine === machine)?.plan ?? {};
  const names = partsOf(list, answer?.parts ?? [], plan);
  const act = async (part: string, change: { pin?: string | null; on?: boolean }) => setWord(await setPlan(part, change));
  return (
    <Sec className="st-side" data-plan={machine}>
      <PageHead>
        <span className="sb-m st-grow">
          <b>{label}</b>
        </span>
        {answer?.os ? <Note>{answer.os}</Note> : null}
        <Btn aria-label="Закрыть" onClick={close}>
          ✕
        </Btn>
      </PageHead>
      <Note>{`план rev ${answer?.rev ?? "—"}${online ? "" : " · не на связи"}`}</Note>
      {word ? (
        <Note tone="bad" role="alert">
          {word}
        </Note>
      ) : null}
      {names.map((name) => {
        const part = answer?.parts.find((p) => p.part === name);
        const entry = plan[name];
        const cat = list?.parts[name];
        const cell = cellOf({ part, entry, stable: cat?.stable, online: online && !!answer });
        return (
          <div key={name} className="st-part" data-part={name}>
            <PageHead>
              <b className="st-grow">{name}</b>
              <span className={`st-cell ${cell.cls}`} title={cell.title}>
                {cell.text}
              </span>
            </PageHead>
            {part?.error ? <Note tone="bad">{part.error}</Note> : null}
            {cat ? (
              <Opts>
                <Btn aria-pressed={entry?.pin ? "false" : "true"} onClick={() => void act(name, { pin: null })}>
                  {`stable ${short(cat.stable)}`}
                </Btn>
                {cat.versions
                  .filter((v) => v !== cat.stable && (v !== cat.edge || cat.edge === v) && cat.versions.indexOf(v) < cat.versions.indexOf(cat.stable))
                  .slice(-1)
                  .map((v) => (
                    <Btn key={v} aria-pressed={entry?.pin === v ? "true" : "false"} onClick={() => void act(name, { pin: v })}>
                      {`📌 ${short(v)}`}
                    </Btn>
                  ))}
                <In mono className="st-ver" aria-label={`Версия ${name}`} placeholder="версия" value={typed[name] ?? ""} onChange={() => {}} onInput={(e) => setTyped({ ...typed, [name]: e.currentTarget.value })} />
                <Btn
                  onClick={() => {
                    const v = (typed[name] ?? "").trim();
                    if (v) void act(name, { pin: v });
                  }}
                >
                  Закрепить
                </Btn>
              </Opts>
            ) : null}
            {name === KEEPER ? null : (
              <Opts>
                <Btn role="switch" aria-checked={entry?.on !== false} aria-pressed={entry?.on !== false ? "true" : "false"} onClick={() => void act(name, { on: entry?.on === false })}>
                  {entry?.on === false ? "выключена" : "включена"}
                </Btn>
              </Opts>
            )}
          </div>
        );
      })}
    </Sec>
  );
}

/** Части машины: каталог «на машине» и что машина прислала сама. */
function partsOf(list: Releases | undefined, parts: KPart[], plan: Record<string, PlanEntry>) {
  const fromCatalog = Object.entries(list?.parts ?? {}).filter(([, p]) => p.where === "machine").map(([n]) => n);
  return [...new Set([...fromCatalog, ...parts.map((p) => p.part), ...Object.keys(plan)])];
}

export function ReleasesTab({ machine }: { machine?: string }) {
  const app = useApp();
  const st = useModule<SettingsState>();
  const hasCatalog = !!app.worker("releases");
  const load = useLoad(() => (hasCatalog ? app.read<Releases>("releases.list") : Promise.resolve({ ok: false as const, error: "" })), [hasCatalog]);
  const hosts = useLoad(() => app.read<{ passes: Pass[] }>("keys.list", { role: "host" }), []);
  const answers = app.use(() => st.keeper.get());
  const online = app.use(() => machinesWith(app));
  const { deployed } = app.use(() => st.get());
  const [view, setView] = useState<"machines" | "catalog">("machines");
  const [picked, setPicked] = useState(machine ?? "");
  const [marked, setMarked] = useState<string[]>([]);
  const [rq, setRq] = useState("");
  useEffect(() => st.keeper.mount(), [st]);

  const list = load.data;
  const machines = [...new Set([...(hosts.data?.passes ?? []).map((p) => p.name), ...online])].sort();
  const needle = rq.trim().toLowerCase();
  const rows = machines.filter((m) => `${m} ${machineLabel(app, m).text}`.toLowerCase().includes(needle));
  const parts = [...new Set([...Object.entries(list?.parts ?? {}).filter(([, p]) => p.where === "machine").map(([n]) => n), ...machines.flatMap((m) => (okOf(answers[m])?.parts ?? []).map((p) => p.part))])];
  const planOf = (m: string) => list?.machines.find((x) => x.machine === m)?.plan ?? {};

  async function setPlan(m: string, part: string, change: { pin?: string | null; on?: boolean }) {
    const r = await app.request<{ rev: number }>("releases.set", { machine: m, part, ...change });
    if (!r.ok) return `@${m} ${part}: ${wordText(r.error)}`;
    app.toast(`@${m}: план rev ${r.result.rev}`, "ok");
    load.reload();
    return "";
  }
  async function setMany(part: string, change: { pin: string | null }) {
    const list_ = marked;
    setMarked([]);
    const answers_ = await Promise.all(list_.map(async (m) => [m, await app.request("releases.set", { machine: m, part, ...change })] as const));
    const good = answers_.filter(([, r]) => r.ok).length;
    const bad = answers_.flatMap(([m, r]) => (r.ok ? [] : [`@${m} ${part}: ${wordText(r.error)}`]));
    app.toast([`${good} ${plural(good, "машина", "машины", "машин")}: план изменён`, ...bad].join("; "), bad.length ? "bad" : "ok");
    load.reload();
  }

  if (!hasCatalog) return <Note>«Выпусков» во флоте нет</Note>;
  const host = list?.parts.host;
  const hostBack = before(host);
  return (
    <>
      <div className="st-tabs">
        <Btn aria-pressed={view === "machines" ? "true" : "false"} onClick={() => setView("machines")}>
          По машинам
        </Btn>
        <Btn aria-pressed={view === "catalog" ? "true" : "false"} onClick={() => setView("catalog")}>
          Каталог и сборки
        </Btn>
      </div>
      {load.error ? (
        <Note tone="bad" role="alert">
          {`releases.list: ${load.error}`}
        </Note>
      ) : null}
      {hosts.error ? (
        <Note tone="bad" role="alert">
          {`keys.list: ${hosts.error}`}
        </Note>
      ) : null}
      {deployed ? (
        <Note tone={deployed.tone} role={deployed.tone === "bad" ? "alert" : "status"}>
          {deployed.text}
        </Note>
      ) : null}
      {view === "catalog" && list ? <Catalog list={list} reload={load.reload} /> : null}
      {view === "machines" ? (
        <>
          {list ? (
            <Sec>
              <b>Stable флота</b>
              {Object.entries(list.parts)
                .filter(([, p]) => p.where === "machine")
                .map(([name, p]) => {
                  const asked = online.filter((m) => okOf(answers[m]));
                  const held = asked.filter((m) => okOf(answers[m])!.parts.find((x) => x.part === name)?.version === p.stable).length;
                  const back = before(p);
                  return (
                    <div key={name} className="st-roll" data-roll={name}>
                      <span className="st-grow">
                        <b>{name}</b> <span className="sb-m">{p.stable}</span>
                      </span>
                      <Meter className="st-bar" value={asked.length ? Math.round((100 * held) / asked.length) : 0} />
                      <Note>{`${held} из ${asked.length} ${plural(asked.length, "машины", "машин", "машин")}`}</Note>
                      {back ? <Btn onClick={() => void st.deploy(name, back, load.reload)}>{`Вернуть ${short(back)}`}</Btn> : null}
                    </div>
                  );
                })}
            </Sec>
          ) : null}
          {marked.length ? (
            <div className="st-bulk" data-bulk="">
              <b>{`Выбрано ${marked.length}`}</b>
              <Note>{marked.map((m) => `@${m}`).join(", ")}</Note>
              <span className="st-grow" />
              {hostBack ? <Btn onClick={() => void setMany("host", { pin: hostBack })}>{`host: закрепить ${short(hostBack)}`}</Btn> : null}
              <Btn onClick={() => void setMany("host", { pin: null })}>host: к stable</Btn>
              <Btn onClick={() => setMarked([])}>Снять</Btn>
            </div>
          ) : null}
          <div className="st-grid">
            <Sec className="st-matrix">
              <PageHead>
                <In className="st-rq" data-f="rq" aria-label="Найти машину" placeholder="Найти машину" value={rq} onChange={() => {}} onInput={(e) => setRq(e.currentTarget.value)} />
                <Note className="st-end">{`${rows.length} ${plural(rows.length, "машина", "машины", "машин")}`}</Note>
              </PageHead>
              <div className="st-scroll">
                <table className="st-mx">
                  <thead>
                    <tr>
                      <th />
                      <th>машина</th>
                      {parts.map((p) => (
                        <th key={p}>{p}</th>
                      ))}
                      <th>план</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((m) => {
                      const answer = okOf(answers[m]);
                      const on = online.includes(m);
                      const cells = parts.map((p) => cellOf({ part: answer?.parts.find((x) => x.part === p), entry: planOf(m)[p], stable: list?.parts[p]?.stable, online: on }));
                      const dot = !on ? "stop" : cells.some((c) => c.cls === "fail") ? "bad" : wordOf(answers[m]) || cells.some((c) => c.cls === "behind") ? "wait" : "idle";
                      return (
                        <tr key={m} data-machine={m} aria-current={picked === m ? "true" : undefined}>
                          <td>
                            <button type="button" className="st-ck" role="checkbox" aria-checked={marked.includes(m)} aria-label={`Выбрать ${m}`} onClick={() => setMarked(marked.includes(m) ? marked.filter((x) => x !== m) : [...marked, m])}>
                              {marked.includes(m) ? "✓" : null}
                            </button>
                          </td>
                          <td>
                            <button type="button" className="sb-rw st-mn" onClick={() => setPicked(m)}>
                              <Dot kind={dot} />
                              {machineLabel(app, m).text}
                            </button>
                          </td>
                          {parts.map((p, i) => (
                            <td key={p} data-part={p}>
                              <span className={`st-cell ${cells[i].cls}`} title={cells[i].title}>
                                {cells[i].text}
                              </span>
                            </td>
                          ))}
                          <td>
                            <Note>{on ? (answer ? `rev ${answer.rev}` : (wordOf(answers[m]) ? `keeper.state: ${wordOf(answers[m])}` : "")) : "не на связи"}</Note>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Sec>
            {picked ? <Plan machine={picked} list={list} close={() => setPicked("")} setPlan={(part, change) => setPlan(picked, part, change)} /> : <span />}
          </div>
        </>
      ) : null}
    </>
  );
}
