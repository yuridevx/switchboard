// «Выпуски»: stable по машинам, матрица машина × часть, план машины, каталог и сборки.
import { useEffect, useState } from "react";
import { Btn, Dot, In, M, machineLabel, Meter, Note, okOf, Opts, PageHead, plural, Sec, useApp, useLoad, useModule, wordOf, type Result } from "@switchboard/web-ui";
import { cellOf, heldBy, older, others, short, wordFor, type Catalog, type KState, type Plan } from "./rules.ts";
import type { KeeperAnswers, SettingsState } from "./state.ts";

const machinesWord = (n: number) => `${n} ${plural(n, "машина", "машины", "машин")}`;

/** Правка плана: releases.set у машины. */
function usePlan(reload: () => void) {
  const app = useApp();
  return async (machine: string, part: string, change: { pin?: string | null; on?: boolean }): Promise<Result<{ rev: number }>> => {
    const r = await app.request<{ rev: number }>("releases.set", { machine, part, ...change });
    reload();
    return r;
  };
}

/** Выложить часть или модуль сборки: итог переживает смену вкладки. */
function useDeploy(reload: () => void) {
  const app = useApp();
  const s = useModule<SettingsState>();
  return async (part: string, version: string) => {
    s.local.set((l) => {
      l.deploying = `${part}:${version}`;
      l.deployed = null;
    });
    const r = await app.request<{ parts: Record<string, { from: string | null; to: string }> }>("releases.deploy", { part, version });
    const text = r.ok ? `Выложено: ${Object.entries(r.result.parts).map(([p, v]) => `${p} ${v.from ?? "—"} → ${v.to}`).join(", ")}` : `Не выложен ${part} ${version}: ${wordFor(r.error)}`;
    s.local.set((l) => {
      l.deploying = "";
      l.deployed = { text, tone: r.ok ? "ok" : "bad" };
    });
    reload();
  };
}

function Stable({ catalog, answers, online, reload }: { catalog: Catalog; answers: KeeperAnswers; online: string[]; reload(): void } ) {
  const app = useApp();
  const s = useModule<SettingsState>();
  const deploy = useDeploy(reload);
  const busy = app.use(() => s.local.get().deploying);
  const parts = Object.entries(catalog.parts).filter(([, p]) => p.where === "machine");
  return (
    <Sec>
      <b>Stable флота</b>
      {parts.map(([name, p]) => {
        const k = (m: string) => okOf(answers[m]);
        const holding = online.filter((m) => k(m) && heldBy(k(m)!, name) === p.stable).length;
        const back = older(p)[0];
        return (
          <div key={name} className="st-roll" data-roll={name}>
            <span className="st-grow">
              <b>{name}</b> <M>{p.stable}</M>
            </span>
            <Meter className="st-bar" value={online.length ? Math.round((100 * holding) / online.length) : 0} warn={holding < online.length} />
            <Note>{`${holding} из ${online.length} машин`}</Note>
            {back && (
              <Btn disabled={!!busy} onClick={() => void deploy(name, back)}>
                {`Вернуть ${short(back)}`}
              </Btn>
            )}
          </div>
        );
      })}
    </Sec>
  );
}

function MachinePlan({ machine, online, catalog, plan, k, set, close }: { machine: string; online: boolean; catalog: Catalog | undefined; plan: Plan; k: KState | undefined; set: ReturnType<typeof usePlan>; close(): void }) {
  const app = useApp();
  const [word, setWord] = useState("");
  const [typed, setTyped] = useState<Record<string, string>>({});
  const label = app.use(() => machineLabel(app, machine).text);
  const parts = [...new Set([...Object.entries(catalog?.parts ?? {}).filter(([, p]) => p.where === "machine").map(([n]) => n), ...(k?.parts.map((p) => p.part) ?? [])])];
  async function change(part: string, body: { pin?: string | null; on?: boolean }) {
    setWord("");
    const r = await set(machine, part, body);
    if (r.ok) app.toast(`${label}: план rev ${r.result.rev}`, "ok");
    else setWord(`${label} ${part}: ${wordFor(r.error)}`);
  }
  return (
    <Sec className="st-side" data-plan={machine}>
      <Opts>
        <M className="st-grow">{label}</M>
        <Btn aria-label="Закрыть" onClick={close}>
          ✕
        </Btn>
      </Opts>
      <Note>{`план rev ${k?.rev ?? "—"}${online ? "" : " · не на связи"}`}</Note>
      {parts.map((part) => {
        const c = catalog?.parts[part];
        const held = k?.parts.find((p) => p.part === part);
        const entry = plan[part];
        const cell = cellOf(k, online, part, entry, c?.stable);
        const version = (typed[part] ?? "").trim();
        return (
          <div key={part} className="st-part" data-part={part}>
            <Opts>
              <b className="st-grow">{part}</b>
              {cell && <span className={`st-cell ${cell.tone}`}>{cell.text}</span>}
              {part !== "keeper" && (
                <Btn role="switch" aria-checked={entry?.on !== false} aria-pressed={entry?.on !== false} onClick={() => void change(part, { on: entry?.on === false })}>
                  {entry?.on === false ? "выключена" : "включена"}
                </Btn>
              )}
            </Opts>
            {held?.error && <Note tone="bad">{held.error}</Note>}
            {c && (
              <Opts>
                <Btn aria-pressed={!entry?.pin} onClick={() => void change(part, { pin: null })}>{`stable ${c.stable}`}</Btn>
                {others(c).map((v) => (
                  <Btn key={v} aria-pressed={entry?.pin === v} onClick={() => void change(part, { pin: v })}>
                    {`📌 ${short(v)}`}
                  </Btn>
                ))}
                <In className="st-ver" mono placeholder="версия" aria-label={`Версия ${part}`} value={typed[part] ?? ""} onInput={(e) => setTyped({ ...typed, [part]: e.currentTarget.value })} />
                <Btn onClick={() => version && void change(part, { pin: version })}>Закрепить</Btn>
              </Opts>
            )}
          </div>
        );
      })}
      {word && <Note tone="bad">{word}</Note>}
    </Sec>
  );
}

function Bulk({ checked, catalog, set }: { checked: string[]; catalog: Catalog | undefined; set: ReturnType<typeof usePlan> }) {
  const app = useApp();
  const s = useModule<SettingsState>();
  const clear = () => s.local.set((l) => void (l.checked = []));
  const host = catalog?.parts.host;
  const back = host && older(host)[0];
  const labels = app.use(() => checked.map((m) => machineLabel(app, m).text));
  async function apply(pin: string | null) {
    clear();
    const results = await Promise.all(checked.map(async (m, i) => ({ label: labels[i], r: await set(m, "host", { pin }) })));
    const done = results.filter((x) => x.r.ok).length;
    const refused = results.flatMap(({ label, r }) => (r.ok ? [] : [`${label} host: ${wordFor(r.error)}`]));
    app.toast([`${machinesWord(done)}: план изменён`, ...refused].join("; "), refused.length ? "bad" : "ok");
  }
  return (
    <div className="st-bulk" data-bulk="">
      <span>{`Выбрано ${checked.length}: ${labels.join(", ")}`}</span>
      {back && <Btn onClick={() => void apply(back)}>{`host: закрепить ${short(back)}`}</Btn>}
      <Btn onClick={() => void apply(null)}>host: к stable</Btn>
      <Btn className="st-end" ghost onClick={clear}>
        Снять
      </Btn>
    </div>
  );
}

function Matrix({ machines, online, catalog, answers, plans, picked, pick, query, setQuery }: { machines: string[]; online: string[]; catalog: Catalog | undefined; answers: KeeperAnswers; plans: Record<string, Plan>; picked: string; pick(m: string): void; query: string; setQuery(q: string): void }) {
  const app = useApp();
  const s = useModule<SettingsState>();
  const checked = app.use(() => s.local.get().checked);
  const labels = app.use(() => Object.fromEntries(machines.map((m) => [m, machineLabel(app, m).text])));
  const parts = [...new Set([...Object.entries(catalog?.parts ?? {}).filter(([, p]) => p.where === "machine").map(([n]) => n), ...machines.flatMap((m) => okOf(answers[m])?.parts.map((p) => p.part) ?? [])])];
  const shown = machines.filter((m) => `${m} ${labels[m]}`.toLowerCase().includes(query.toLowerCase()));
  const toggle = (m: string) => s.local.set((l) => void (l.checked = checked.includes(m) ? checked.filter((x) => x !== m) : [...checked, m]));
  return (
    <Sec className="st-matrix">
      <PageHead>
        <In className="st-rq" data-f="rq" placeholder="Найти машину" aria-label="Найти машину" value={query} onInput={(e) => setQuery(e.currentTarget.value)} />
        <Note className="st-end">{machinesWord(shown.length)}</Note>
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
            {shown.map((m) => {
              const k = okOf(answers[m]);
              const on = checked.includes(m);
              return (
                <tr key={m} data-machine={m} aria-current={picked === m || undefined}>
                  <td>
                    <button type="button" className="st-ck" role="checkbox" aria-checked={on} aria-label={`Выбрать ${m}`} onClick={() => toggle(m)}>
                      {on ? "✓" : ""}
                    </button>
                  </td>
                  <td>
                    <button type="button" className="sb-rw st-mn" onClick={() => pick(m)}>
                      <Dot kind={!online.includes(m) ? "gone" : k?.parts.some((p) => p.state === "failed") ? "bad" : "idle"} />
                      {labels[m]}
                    </button>
                  </td>
                  {parts.map((p) => {
                    const c = cellOf(k, online.includes(m), p, plans[m]?.[p], catalog?.parts[p]?.stable);
                    return (
                      <td key={p} data-part={p}>
                        {c && (
                          <span className={`st-cell ${c.tone}`} title={c.title}>
                            {c.text}
                          </span>
                        )}
                      </td>
                    );
                  })}
                  <td>
                    <Note>{online.includes(m) ? (k ? `rev ${k.rev}` : "") : "не на связи"}</Note>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Sec>
  );
}

function Build({ catalog, reload }: { catalog: Catalog; reload(): void }) {
  const app = useApp();
  const s = useModule<SettingsState>();
  const deploy = useDeploy(reload);
  const busy = app.use(() => s.local.get().deploying);
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
            {Object.entries(catalog.parts).map(([name, p]) => (
              <tr key={name} data-part={name}>
                <td>{name}</td>
                <td>{p.where === "machine" ? "машины" : "Cloudflare"}</td>
                <td>
                  <M>{p.stable}</M>
                </td>
                <td>
                  <M>{p.versions.map(short).join(" · ")}</M>
                </td>
                <td>
                  <Opts>
                    {p.edge !== p.stable && (
                      <Btn pri disabled={!!busy} onClick={() => void deploy(name, p.edge)}>
                        {busy === `${name}:${p.edge}` ? "Выкладываю…" : `Выложить ${short(p.edge)}`}
                      </Btn>
                    )}
                    {older(p).map((v) => (
                      <Btn key={v} data-back={v} disabled={!!busy} onClick={() => void deploy(name, v)}>
                        {`Вернуть ${short(v)}`}
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
            {Object.entries(catalog.modules).map(([name, m]) => {
              const newer = Object.values(m.built).some((v) => v !== m.edge);
              return (
                <tr key={name} data-module={name}>
                  <td>{name}</td>
                  <td>{m.into.join(", ")}</td>
                  <td>
                    <M>{Object.entries(m.built).map(([app_, v]) => `${app_} ${v}`).join(" · ")}</M>
                  </td>
                  <td>
                    <M>{newer ? m.edge : null}</M>
                  </td>
                  <td>
                    {newer && (
                      <Btn disabled={!!busy} onClick={() => void deploy(name, m.edge)}>
                        {busy === `${name}:${m.edge}` ? "Выкладываю…" : `Выложить ${m.edge}`}
                      </Btn>
                    )}
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

export function ReleasesTab({ machine }: { machine?: string }) {
  const app = useApp();
  const s = useModule<SettingsState>();
  const present = !!app.worker("releases");
  const list = useLoad<Catalog | null>(() => (present ? app.read<Catalog>("releases.list") : Promise.resolve({ ok: true, result: null })), []);
  const hosts = useLoad(() => app.read<{ passes: Array<{ name: string; role: string }> }>("keys.list", { role: "host" }), []);
  const answers = app.use(() => s.answers.get());
  const online = app.use(() => (app.roster()?.machines ?? []).map((m) => m.machine));
  const local = app.use(() => s.local.get());
  const [picked, setPicked] = useState(machine ?? "");
  const [query, setQuery] = useState("");
  useEffect(() => s.answers.mount(), [s]);
  const set = usePlan(list.reload);
  if (!present) return <Note>«Выпусков» во флоте нет</Note>;
  const catalog = list.data ?? undefined;
  const machines = [...new Set([...online, ...(hosts.data?.passes ?? []).map((p) => p.name)])].sort();
  const plans = Object.fromEntries((catalog?.machines ?? []).map((m) => [m.machine, m.plan]));
  const setCatalog = (on: boolean) => s.local.set((l) => void (l.catalog = on));
  return (
    <>
      <div className="st-tabs">
        <Btn aria-pressed={!local.catalog} onClick={() => setCatalog(false)}>
          По машинам
        </Btn>
        <Btn aria-pressed={local.catalog} onClick={() => setCatalog(true)}>
          Каталог и сборки
        </Btn>
      </div>
      {list.error && <Note tone="bad">{`releases.list: ${list.error}`}</Note>}
      {hosts.error && <Note tone="bad">{`keys.list: ${hosts.error}`}</Note>}
      {local.deployed && <Note tone={local.deployed.tone}>{local.deployed.text}</Note>}
      {local.catalog && catalog && <Build catalog={catalog} reload={list.reload} />}
      {!local.catalog && (
        <>
          {catalog && <Stable catalog={catalog} answers={answers} online={online} reload={list.reload} />}
          {local.checked.length > 0 && <Bulk checked={local.checked} catalog={catalog} set={set} />}
          <div className="st-grid">
            <Matrix machines={machines} online={online} catalog={catalog} answers={answers} plans={plans} picked={picked} pick={setPicked} query={query} setQuery={setQuery} />
            {picked && <MachinePlan machine={picked} online={online.includes(picked)} catalog={catalog} plan={plans[picked] ?? {}} k={okOf(answers[picked])} set={set} close={() => setPicked("")} />}
          </div>
        </>
      )}
      {wordOf(answers[picked]) ? <Note tone="bad">{`keeper.state: ${wordOf(answers[picked])}`}</Note> : null}
    </>
  );
}
