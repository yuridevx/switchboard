// Карточка на пульте: шапка одной строкой с окнами, плашка сбоя, вкладки, сведения сбоку.
import { useEffect, useState } from "react";
import { machineOf, userOf } from "@switchboard/protocol";
import type { ScreenProps } from "@switchboard/web-core";
import { at, Btn, Dot, effortName, EFFORTS, failText, incidentOf, LIMIT_NAMES, LIMIT_WARN, LimitRow, machineLabel, MODELS, profileNameOf, remoteOf, sessionLabel, sessionOf, slotOf, stateLabel, Tabs, useApp, useMachineLoad, useModule, type AccountsAnswer, type ModelInfo } from "@switchboard/web-ui";
import { Aside } from "./aside.tsx";
import type { CardState } from "./module.tsx";
import { LogTab, SetTab } from "./tabs.tsx";

type Pop = "" | "model" | "acc" | "menu";
const classes = (...list: unknown[]) => list.filter(Boolean).join(" ");

function Kv({ rows }: { rows: Array<[string, unknown]> }) {
  return <dl className="cw-kv">{rows.filter(([, v]) => v).flatMap(([k, v]) => [<dt key={k}>{k}</dt>, <dd key={`${k}=`}>{String(v)}</dd>])}</dl>;
}

function ModelPop({ callsign, close }: { callsign: string; close(): void }) {
  const app = useApp();
  const s = app.use(() => sessionOf(app, callsign));
  const models = app.use(() => app.mark("models", callsign) as ModelInfo[] | null | undefined);
  useEffect(() => app.run("models.load", { callsign }), [app, callsign]);
  async function set(body: Record<string, string>, word: string) {
    close();
    const r = await app.request("session.update", { callsign, ...body });
    if (!r.ok) app.toast(`${callsign}: ${word} — ${r.error}`, "bad");
  }
  const list = models ?? MODELS.map((value) => ({ value, displayName: value }));
  return (
    <div className="cw-pop l" role="dialog" aria-label="Модель и усилие">
      <span className="lb">Модель</span>
      {list.map((m) => (
        <button key={m.value} type="button" className="cw-mi" data-model={m.value} onClick={() => void set({ model: m.value }, "модель")}>
          {`${m.value === s?.model ? "✓ " : ""}${m.displayName ?? m.value}`}
        </button>
      ))}
      <hr />
      <span className="lb">Усилие</span>
      {EFFORTS.map(([e, name]) => (
        <button key={e} type="button" className="cw-mi" data-effort={e} onClick={() => void set({ effort: e }, "усилие")}>
          {`${e === s?.effort ? "✓ " : ""}${name}`}
        </button>
      ))}
    </div>
  );
}

function AccountPop({ callsign, accounts, toSlots }: { callsign: string; accounts: AccountsAnswer | undefined; toSlots(): void }) {
  const app = useApp();
  const s = app.use(() => sessionOf(app, callsign));
  const name = s?.account as string | undefined;
  const slot = slotOf(s)?.name;
  const info = name ? accounts?.accounts[name] : undefined;
  const order = slot ? accounts?.slots?.[slot]?.order : undefined;
  return (
    <div className="cw-pop l w" role="dialog" aria-label="Аккаунт и лимиты">
      <Kv rows={[["аккаунт", [name, info?.plan].filter(Boolean).join(" · ")], ["слот", slot && `${slot} @${machineOf(callsign)}`]]} />
      {Object.entries(info?.limits ?? {}).map(([k, w]) => (
        <LimitRow key={k} className="cw-win" data-win={k} label={LIMIT_NAMES[k] ?? k} used={w.utilization} resets={w.resetsAt} />
      ))}
      {order && order.length > 0 && <span className="cw-note queue">{`очередь слота: ${order.join(" → ")}`}</span>}
      <hr />
      <button type="button" className="cw-mi" onClick={toSlots}>
        Сменить слот
      </button>
    </div>
  );
}

function MenuPop({ callsign, close }: { callsign: string; close(): void }) {
  const app = useApp();
  const c = useModule<CardState>();
  const s = app.use(() => sessionOf(app, callsign));
  const info = app.use(() => c.device.get().info);
  const incident = incidentOf(s);
  const remote = remoteOf(s);
  return (
    <div className="cw-pop r" role="dialog" aria-label={`Сессия ${callsign}`}>
      <Kv rows={[["профиль", profileNameOf(s)], ["папка", s?.dir], ["машина", `@${machineOf(callsign)}`], ["инцидент", incident && [incident.type, incident.key].filter(Boolean).join(" · ")]]} />
      {remote && (
        <a className="cw-mi" href={remote} target="_blank" rel="noreferrer">
          Открыть в claude.ai ↗
        </a>
      )}
      <button type="button" className="cw-mi" data-act="info" onClick={() => (c.setInfo(!info), close())}>
        {info ? "✓ Сведения сбоку" : "Сведения сбоку"}
      </button>
    </div>
  );
}

function Head({ callsign, accounts, tabs, tab, pick, names }: { callsign: string; accounts: AccountsAnswer | undefined; tabs: Array<[string, string]>; tab: string; pick(k: string): void; names(): void }) {
  const app = useApp();
  const c = useModule<CardState>();
  const machine = machineOf(callsign)!;
  const [pop, setPop] = useState<Pop>("");
  const s = app.use(() => sessionOf(app, callsign));
  const name = app.use(() => sessionLabel(app, callsign));
  const place = app.use(() => machineLabel(app, machine));
  const head = app.use(() => c.device.get().head);
  const placed = app.use(() => app.placed("card.menu", { callsign }));
  const update = app.use(() => app.can(machine, "session.update") === true);
  const start = app.use(() => app.can(machine, "session.start") === true);
  useEffect(() => {
    if (!pop) return;
    const click = (e: MouseEvent) => !(e.target as Element).closest?.(".cw-pop, [data-pop]") && setPop("");
    const key = (e: KeyboardEvent) => e.key === "Escape" && setPop("");
    document.addEventListener("click", click);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("click", click);
      document.removeEventListener("keydown", key);
    };
  }, [pop]);
  const toggle = (p: Pop) => setPop(pop === p ? "" : p);
  const failed = s?.state === "failed";
  const title = failed ? `не запустилась${failText(s) ? `: ${failText(s)}` : ""}` : stateLabel(s?.state).text;
  const account = s?.account as string | undefined;
  const wait = slotOf(s)?.wait;
  const used = account ? accounts?.accounts[account]?.limits?.five_hour?.utilization : undefined;
  const percent = used === undefined ? null : Math.round(used * 100);
  const owner = typeof s?.by === "string" ? userOf(s.by)?.slice(1) : undefined;
  async function run() {
    const r = await app.request("session.start", { callsign });
    if (!r.ok) app.toast(`${callsign}: «Запустить» — ${r.error}`, "bad");
  }
  return (
    <div className="cw-h">
      <div className="cw-hl">
        {s && <Dot className="cw-lamp" kind={stateLabel(s.state).dot} title={title} aria-label={title} />}
        <button type="button" className="cw-nm" data-act="names" aria-label="Имена сессии и машины" onClick={names}>
          <span className="cw-nm1">
            <span className={classes("cw-cs", name.human && "hum")}>{name.text}</span>
            <span className={classes("cw-at", place.human && "hum")}>{place.text}</span>
            <span className="cw-ed">✎</span>
          </span>
          {head.haddr && name.human && <span className="cw-real">{callsign}</span>}
        </button>
        {!s && <span className="cw-why">не на связи</span>}
        {s && (
          <span className="cw-meta">
            {head.howner && owner}
            {head.hprof && profileNameOf(s) && <span className="cw-pill">{profileNameOf(s)}</span>}
          </span>
        )}
      </div>
      <div className="cw-hr">
        {s && (
          <div className="cw-hpw">
            {head.hmodel && (
              <button type="button" className="cw-hb" data-pop="model" disabled={!update} onClick={() => toggle("model")}>
                {`${[s.model, effortName(s.effort)].filter(Boolean).join(" · ")} ▾`}
              </button>
            )}
            {account && (
              <button type="button" className={classes("cw-hb", wait ? "you" : percent !== null && percent >= LIMIT_WARN && "lim")} data-pop="acc" onClick={() => toggle("acc")}>
                {`${account}${wait ? ` · ждёт сброса ${at(wait)}` : percent !== null ? ` · ${percent} %` : ""} ▾`}
              </button>
            )}
            {pop === "model" && <ModelPop callsign={callsign} close={() => setPop("")} />}
            {pop === "acc" && (
              <AccountPop
                callsign={callsign}
                accounts={accounts}
                toSlots={() => {
                  setPop("");
                  pick("set");
                }}
              />
            )}
          </div>
        )}
        <Tabs className="cw-tabs" tabs={tabs} cur={tab} pick={pick} />
        {placed.map((p) => (
          <Btn key={p.name} data-screen={p.name} onClick={() => app.run(p.name, { callsign })}>
            {p.label}
          </Btn>
        ))}
        {(s?.state === "stopped" || failed) && start && <Btn pri onClick={() => void run()}>Запустить</Btn>}
        {s && (
          <div className="cw-mw">
            <button type="button" className="cw-hb cw-more" data-pop="menu" aria-label="Действия сессии" onClick={() => toggle("menu")}>
              ⋯
            </button>
            {pop === "menu" && <MenuPop callsign={callsign} close={() => setPop("")} />}
          </div>
        )}
      </div>
    </div>
  );
}

export function WideCard({ params }: ScreenProps) {
  const app = useApp();
  const c = useModule<CardState>();
  const { callsign } = params;
  const machine = machineOf(callsign)!;
  const [wanted, setTab] = useState(params.tab ?? "chat");
  const [names, setNames] = useState(false);
  const s = app.use(() => sessionOf(app, callsign));
  const info = app.use(() => c.device.get().info);
  const journal = app.use(() => app.can(machine, "machine.journal") === true);
  const placed = app.use(() => app.placed("card.tab", { callsign }));
  const accounts = useMachineLoad<AccountsAnswer>(machine, "machine.accounts");
  const tabs: Array<[string, string]> = [["chat", "Разговор"], ...placed.map((p): [string, string] => [p.name, p.label]), ["set", "Настройки"], ...(journal ? [["log", "Журнал"] as [string, string]] : [])];
  // вкладка пропала — запасная «Настройки»
  const tab = tabs.some(([k]) => k === wanted) ? wanted : "set";
  const failed = s?.state === "failed";
  const why = s && failText(s);
  return (
    <div className="cw">
      <Head callsign={callsign} accounts={accounts.data} tabs={tabs} tab={tab} pick={setTab} names={() => setNames(true)} />
      <div className="cw-pl" hidden={!failed}>
        {failed && (
          <>
            <b>{why ? `Не запустилась: ${why}` : "Не запустилась"}</b>
            {journal && <Btn onClick={() => setTab("log")}>Почему</Btn>}
          </>
        )}
      </div>
      <div className={classes("cw-body", info && "info")}>
        <div className="cw-place">
          {tab === "set" && <SetTab callsign={callsign} machine={machine} accounts={accounts.data} error={accounts.error} />}
          {tab === "log" && <LogTab callsign={callsign} machine={machine} />}
          {tab !== "set" && tab !== "log" && <app.Slot screen={tab} params={{ callsign }} />}
        </div>
        {info && <Aside callsign={callsign} machine={machine} />}
      </div>
      {names && <app.Slot screen="labels" params={{ callsign }} close={() => setNames(false)} />}
    </div>
  );
}
