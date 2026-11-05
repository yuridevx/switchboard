// «Выпуски»: stable по машинам, матрица машина × часть, план машины, каталог и сборки.
import { useEffect, useState } from "react";
import { Btn, Dot, In, machineLabel, Note, okOf, Opts, plural, Sec, useApp, useLoad, useModule, wordOf, type Result } from "@switchboard/web-ui";
import { cellOf, older, short, wordFor, type Catalog, type KState, type Plan } from "./rules.ts";
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
      l.deploying = part;
      l.deployed = null;
    });
    const r = await app.request<{ parts: Record<string, { from: string; to: string }> }>("releases.deploy", { part, version });
    const text = r.ok ? `Выложено: ${Object.entries(r.result.parts).map(([p, v]) => `${p} ${v.from} → ${v.to}`).join(", ")}` : `Не выложен ${part} ${version}: ${wordFor(r.error)}`;
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
        const holding = online.filter((m) => cellOf(okOf(answers[m]), name, undefined, p.stable).text === p.stable).length;
        const back = older(p)[0];
        return (
          <div key={name} className="st-roll" data-roll={name}>
            <span>{`${name} ${p.stable}`}</span>
            <span className="st-bar" />
            <span>{`${holding} из ${online.length}`}</span>
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

function MachinePlan({ machine, catalog, plan, k, set, close }: { machine: string; catalog: Catalog | undefined; plan: Plan; k: KState | undefined; set: ReturnType<typeof usePlan>; close(): void }) {
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
        <b className="st-grow">{label}</b>
        <Btn ghost aria-label="Закрыть" onClick={close}>
          ✕
        </Btn>
      </Opts>
      <Note>{`план rev ${catalog?.rev ?? k?.rev ?? "—"}`}</Note>
      {parts.map((part) => {
        const c = catalog?.parts[part];
        const held = k?.parts.find((p) => p.part === part);
        const entry = plan[part];
        const back = c && older(c)[0];
        const version = (typed[part] ?? "").trim();
        return (
          <div key={part} className="st-part" data-part={part}>
            <Opts>
              <b>{part}</b>
              <span>{entry?.pin ?? held?.version ?? "—"}</span>
              {part !== "keeper" && <Btn onClick={() => void change(part, { on: entry?.on === false })}>{entry?.on === false ? "выключена" : "включена"}</Btn>}
            </Opts>
            {held?.error && <Note tone="bad">{held.error}</Note>}
            {c && (
              <Opts>
                {entry?.pin && <Btn onClick={() => void change(part, { pin: null })}>{`stable ${c.stable}`}</Btn>}
                {back && back !== entry?.pin && <Btn onClick={() => void change(part, { pin: back })}>{`📌 ${short(back)}`}</Btn>}
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
    <div className="st-bulk" data-bulk="1">
      <span>{`Выбрано ${checked.length}: ${labels.join(", ")}`}</span>
      {back && <Btn onClick={() => void apply(back)}>{`host: закрепить ${short(back)}`}</Btn>}
      <Btn onClick={() => void apply(null)}>host: к stable</Btn>
      <Btn className="st-end" ghost onClick={clear}>
        Снять
      </Btn>
    </div>
  );
}

function Matrix({ machines, catalog, answers, plans, picked, pick, query, setQuery }: { machines: string[]; catalog: Catalog | undefined; answers: KeeperAnswers; plans: Record<string, Plan>; picked: string; pick(m: string): void; query: string; setQuery(q: string): void }) {
  const app = useApp();
  const s = useModule<SettingsState>();
  const checked = app.use(() => s.local.get().checked);
  const labels = app.use(() => Object.fromEntries(machines.map((m) => [m, machineLabel(app, m).text])));
  const parts = [...new Set([...Object.entries(catalog?.parts ?? {}).filter(([, p]) => p.where === "machine").map(([n]) => n), ...machines.flatMap((m) => okOf(answers[m])?.parts.map((p) => p.part) ?? [])])];
  const shown = machines.filter((m) => `${m} ${labels[m]}`.toLowerCase().includes(query.toLowerCase()));
  const toggle = (m: string) => s.local.set((l) => void (l.checked = checked.includes(m) ? checked.filter((x) => x !== m) : [...checked, m]));
  return (
    <Sec className="st-matrix">
      <Opts>
        <In className="st-rq" data-f="rq" placeholder="Найти машину" aria-label="Найти машину" value={query} onInput={(e) => setQuery(e.currentTarget.value)} />
        <span className="st-end">{machinesWord(machines.length)}</span>
      </Opts>
      <div className="st-scroll">
        <table className="st-mx">
          <thead>
            <tr>
              <th />
              <th>машина</th>
              <th>план</th>
              {parts.map((p) => (
                <th key={p}>{p}</th>
              ))}
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
                    <button type="button" className="st-mn" onClick={() => pick(m)}>
                      <Dot kind={k ? (k.parts.some((p) => p.state === "failed") ? "bad" : "idle") : "gone"} />
                      {labels[m]}
                    </button>
                  </td>
                  <td>{k ? `rev ${k.rev}` : ""}</td>
                  {parts.map((p) => {
                    const c = cellOf(k, p, plans[m]?.[p], catalog?.parts[p]?.stable);
                    return (
                      <td key={p} data-part={p}>
                        <span className={["st-cell", c.tone].filter(Boolean).join(" ")}>{c.text}</span>
                      </td>
                    );
                  })}
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
              <th>edge</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {Object.entries(catalog.parts).map(([name, p]) => (
              <tr key={name} data-part={name}>
                <td>{name}</td>
                <td>{p.where === "cloud" ? "Cloudflare" : "машины"}</td>
                <td>{p.stable}</td>
                <td>{p.edge}</td>
                <td>
                  <Opts>
                    {busy === name && <span>Выкладываю…</span>}
                    {p.edge !== p.stable && (
                      <Btn pri disabled={!!busy} onClick={() => void deploy(name, p.edge)}>
                        {`Выложить ${short(p.edge)}`}
                      </Btn>
                    )}
                    {older(p).map((v) => (
                      <Btn key={v} disabled={!!busy} onClick={() => void deploy(name, v)}>
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
            </tr>
          </thead>
          <tbody>
            {Object.entries(catalog.modules).map(([name, m]) => {
              const built = [...new Set(Object.values(m.built))];
              return (
                <tr key={name} data-module={name}>
                  <td>{name}</td>
                  <td>{m.into.join(", ")}</td>
                  <td>{built.join(", ")}</td>
                  <td>
                    {busy === name && <span>Выкладываю…</span>}
                    {built.some((v) => v !== m.edge) && (
                      <Btn disabled={!!busy} onClick={() => void deploy(name, m.edge)}>
                        {`Выложить ${m.edge}`}
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
  const machines = [...new Set([...online, ...(hosts.data?.passes ?? []).map((p) => p.name)])];
  const plans = Object.fromEntries((catalog?.machines ?? []).map((m) => [m.machine, m.plan]));
  const toggleCatalog = () => s.local.set((l) => void (l.catalog = !l.catalog));
  return (
    <>
      <Opts>
        <Btn onClick={toggleCatalog}>{local.catalog ? "Машины" : "Каталог и сборки"}</Btn>
      </Opts>
      {list.error && <Note tone="bad">{`releases.list: ${list.error}`}</Note>}
      {hosts.error && <Note tone="bad">{`keys.list: ${hosts.error}`}</Note>}
      {local.deployed && <Note tone={local.deployed.tone}>{local.deployed.text}</Note>}
      {local.catalog && catalog && <Build catalog={catalog} reload={list.reload} />}
      {!local.catalog && (
        <>
          {catalog && <Stable catalog={catalog} answers={answers} online={online} reload={list.reload} />}
          {local.checked.length > 0 && <Bulk checked={local.checked} catalog={catalog} set={set} />}
          <div className="st-grid">
            <Matrix machines={machines} catalog={catalog} answers={answers} plans={plans} picked={picked} pick={setPicked} query={query} setQuery={setQuery} />
            {picked && <MachinePlan machine={picked} catalog={catalog} plan={plans[picked] ?? {}} k={okOf(answers[picked])} set={set} close={() => setPicked("")} />}
          </div>
        </>
      )}
      {wordOf(answers[picked]) ? <Note tone="bad">{`keeper.state: ${wordOf(answers[picked])}`}</Note> : null}
    </>
  );
}
