// Шапка широкой карточки: лампа, имя, модель и аккаунт с их окнами, вкладки, меню сессии.
import { useEffect, useState } from "react";
import { machineOf, userOf } from "@switchboard/protocol";
import { at, Btn, Dot, effortName, EFFORTS, failText, IconBtn, incidentOf, lamp, LIMIT_NAMES, LIMIT_WARN, LimitRow, machineLabel, MODELS, myAddress, profileNameOf, remoteOf, RowBtn, sessionLabel, sessionOf, slotOf, stateLabel, Tabs, useApp, useModule, type AccountsAnswer, type ModelInfo } from "@switchboard/web-ui";
import type { SessionRecord } from "@switchboard/web-core";
import type { CardState } from "./module.tsx";

type Pop = "" | "model" | "acc" | "menu";
type Pops = { pop: Pop; setPop(p: Pop): void; toggle(p: Pop): void };
const classes = (...list: unknown[]) => list.filter(Boolean).join(" ");
const useHead = () => {
  const app = useApp();
  const card = useModule<CardState>();
  return app.use(() => card.device.get().head);
};

/** Окно шапки одно; щелчок мимо и Esc его закрывают. */
function usePop(): Pops {
  const [pop, setPop] = useState<Pop>("");
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
  return { pop, setPop, toggle: (p) => setPop(pop === p ? "" : p) };
}

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
    if (!r.ok) app.toast(`${callsign}: ${word} — ${r.error}`);
  }
  const list = models?.length ? models : MODELS.map((value) => ({ value, displayName: undefined }));
  return (
    <div className="cw-pop l" role="dialog" aria-label="Модель и усилие">
      <span className="lb">Модель</span>
      {list.map((m) => (
        <RowBtn key={m.value} className="cw-mi" role="menuitemradio" aria-checked={s?.model === m.value} data-model={m.value} onClick={() => void set({ model: m.value }, "модель")}>
          {`${m.value === s?.model ? "✓ " : ""}${m.displayName ?? m.value}`}
        </RowBtn>
      ))}
      <hr />
      <span className="lb">Усилие</span>
      <div className="cw-opts">
        {EFFORTS.map(([e, name]) => (
          <Btn key={e} aria-pressed={e === s?.effort} data-effort={e} onClick={() => void set({ effort: e }, "усилие")}>
            {name}
          </Btn>
        ))}
      </div>
    </div>
  );
}

function AccountPop({ callsign, s, accounts, toSlots }: { callsign: string; s: SessionRecord; accounts: AccountsAnswer | undefined; toSlots(): void }) {
  const name = String(s.account ?? "");
  const slot = slotOf(s)?.name ?? "";
  const info = accounts?.accounts?.[name];
  const order = accounts?.slots?.[slot]?.order ?? [];
  return (
    <div className="cw-pop l w" role="dialog" aria-label="Аккаунт и лимиты">
      <Kv rows={[["аккаунт", [name, info?.plan].filter(Boolean).join(" · ")], ["слот", `${slot} @${machineOf(callsign)}`]]} />
      {Object.entries(info?.limits ?? {}).map(([k, w]) => (
        <LimitRow key={k} className="cw-win" data-win={k} label={LIMIT_NAMES[k] ?? k} used={w.utilization} resets={w.resetsAt} />
      ))}
      {order.length > 0 && <span className="cw-note queue">{`очередь слота: ${order.join(" → ")}`}</span>}
      <div className="cw-opts">
        <Btn onClick={toSlots}>Сменить слот</Btn>
      </div>
    </div>
  );
}

function MenuPop({ callsign, s, close }: { callsign: string; s: SessionRecord; close(): void }) {
  const app = useApp();
  const c = useModule<CardState>();
  const info = app.use(() => c.device.get().info);
  const incident = incidentOf(s);
  const remote = remoteOf(s);
  return (
    <div className="cw-pop r" role="menu" aria-label={`Сессия ${callsign}`}>
      <Kv rows={[["профиль", profileNameOf(s)], ["папка", s.dir], ["машина", `@${machineOf(callsign)}`], ["инцидент", incident && `${incident.type} · ${incident.key}`]]} />
      {remote && (
        <a className="cw-mi" href={remote} target="_blank" rel="noopener" role="menuitem">
          Открыть в claude.ai ↗
        </a>
      )}
      <RowBtn className="cw-mi" role="menuitemcheckbox" aria-checked={info} data-act="info" onClick={() => (c.setInfo(!info), close())}>
        {info ? "✓ Сведения сбоку" : "Сведения сбоку"}
      </RowBtn>
    </div>
  );
}

function Lamp({ s }: { s: SessionRecord | undefined }) {
  if (!s) return <Dot className="cw-lamp" kind="stop" role="img" title="не на связи" aria-label="не на связи" />;
  const why = failText(s);
  const title = s.state === "failed" && why ? `не запустилась: ${why}` : stateLabel(s.state).text;
  return <Dot className="cw-lamp" kind={lamp(s)} role="img" tabIndex={0} data-tip={title} title={title} aria-label={title} />;
}

function NameBtn({ callsign, online, names }: { callsign: string; online: boolean; names(): void }) {
  const app = useApp();
  const head = useHead();
  const name = app.use(() => sessionLabel(app, callsign));
  const place = app.use(() => machineLabel(app, machineOf(callsign)!));
  return (
    <IconBtn className="cw-nm" data-act="names" aria-label="Имена сессии и машины" onClick={names}>
      <span className="cw-nm1">
        <b className={classes("cw-cs", name.human && "hum")}>{name.text}</b>
        <span className={classes("cw-at", place.human && "hum")}>{place.text}</span>
        <span className="cw-ed" aria-hidden="true">
          ✎
        </span>
      </span>
      {online && head.haddr && (name.human || place.human) && <span className="cw-real">{callsign}</span>}
    </IconBtn>
  );
}

function Meta({ s }: { s: SessionRecord }) {
  const app = useApp();
  const head = useHead();
  const owner = typeof s.by === "string" ? userOf(s.by) : null;
  return (
    <span className="cw-meta">
      {head.howner && owner && owner !== myAddress(app) && <span className="cw-pill">{owner.slice(1)}</span>}
      {head.hprof && profileNameOf(s) && <span className="cw-pill">{profileNameOf(s)}</span>}
    </span>
  );
}

function ModelChip({ s, machine, pops }: { s: SessionRecord; machine: string; pops: Pops }) {
  const app = useApp();
  const update = app.use(() => app.can(machine, "session.update") === true);
  return (
    <Btn className="cw-hb" data-pop="model" aria-expanded={pops.pop === "model"} disabled={!update} onClick={() => pops.toggle("model")}>
      {`${[s.model, effortName(s.effort)].filter(Boolean).join(" · ") || "модель"} ▾`}
    </Btn>
  );
}

function AccountChip({ s, accounts, pops }: { s: SessionRecord; accounts: AccountsAnswer | undefined; pops: Pops }) {
  const wait = slotOf(s)?.wait;
  const five = accounts?.accounts?.[String(s.account)]?.limits?.five_hour;
  const used = five ? Math.round(five.utilization * 100) : 0;
  const text = [s.account, wait ? `ждёт сброса ${at(wait)}` : five ? `${used} %` : ""].filter(Boolean).join(" · ");
  return (
    <Btn className={classes("cw-hb", wait ? "you" : used >= LIMIT_WARN && "lim")} data-pop="acc" aria-expanded={pops.pop === "acc"} onClick={() => pops.toggle("acc")}>
      {`${text} ▾`}
    </Btn>
  );
}

function Chips({ callsign, s, accounts, pops, pick }: { callsign: string; s: SessionRecord; accounts: AccountsAnswer | undefined; pops: Pops; pick(k: string): void }) {
  const head = useHead();
  const toSlots = () => {
    pops.setPop("");
    pick("set");
  };
  return (
    <span className="cw-hpw">
      {head.hmodel && <ModelChip s={s} machine={machineOf(callsign)!} pops={pops} />}
      {!!s.account && <AccountChip s={s} accounts={accounts} pops={pops} />}
      {pops.pop === "model" && <ModelPop callsign={callsign} close={() => pops.setPop("")} />}
      {pops.pop === "acc" && <AccountPop callsign={callsign} s={s} accounts={accounts} toSlots={toSlots} />}
    </span>
  );
}

/** Сессия не идёт: запуск прямо из шапки. */
function Start({ callsign, s }: { callsign: string; s: SessionRecord }) {
  const app = useApp();
  const can = app.use(() => app.can(machineOf(callsign)!, "session.start") === true);
  async function run() {
    const r = await app.request("session.start", { callsign });
    if (!r.ok) app.toast(`${callsign}: «Запустить» — ${r.error}`);
  }
  if (!can || (s.state !== "stopped" && s.state !== "failed")) return null;
  return (
    <Btn pri onClick={() => void run()}>
      Запустить
    </Btn>
  );
}

export function Head({ callsign, accounts, tabs, tab, pick, names }: { callsign: string; accounts: AccountsAnswer | undefined; tabs: Array<[string, string]>; tab: string; pick(k: string): void; names(): void }) {
  const app = useApp();
  const pops = usePop();
  const s = app.use(() => sessionOf(app, callsign));
  const placed = app.use(() => app.placed("card.menu", { callsign }));
  return (
    <div className="cw-h">
      <div className="cw-hl">
        <Lamp s={s} />
        <NameBtn callsign={callsign} online={!!s} names={names} />
        {s ? <Meta s={s} /> : <span className="cw-note">не на связи</span>}
      </div>
      <div className="cw-hr">
        {s && <Chips callsign={callsign} s={s} accounts={accounts} pops={pops} pick={pick} />}
        <Tabs className="cw-tabs" tabs={tabs} cur={tab} pick={pick} />
        {placed.map((p) => (
          <Btn key={p.name} data-screen={p.name} onClick={() => app.run(p.name, { callsign })}>
            {p.label}
          </Btn>
        ))}
        {s && <Start callsign={callsign} s={s} />}
        {s && (
          <span className="cw-mw">
            <Btn ghost className="cw-more" data-pop="menu" aria-label="Действия сессии" aria-haspopup="menu" aria-expanded={pops.pop === "menu"} onClick={() => pops.toggle("menu")}>
              ⋯
            </Btn>
            {pops.pop === "menu" && <MenuPop callsign={callsign} s={s} close={() => pops.setPop("")} />}
          </span>
        )}
      </div>
    </div>
  );
}
