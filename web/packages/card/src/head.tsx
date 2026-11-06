// Шапка широкой карточки в одну строку: лампа, имя, короткие настройки или участники пары, вкладки. Окон нет: настройка ведёт на свою вкладку, что не влезло — в подсказке и в «Сведениях».
import { machineOf, userOf } from "@switchboard/protocol";
import { at, Btn, Dot, effortName, failText, IconBtn, lamp, LIMIT_WARN, machineLabel, myAddress, profileNameOf, sessionLabel, sessionOf, slotOf, stateLabel, Tabs, useApp, useModule, wingOf, type AccountsAnswer } from "@switchboard/web-ui";
import type { SessionRecord } from "@switchboard/web-core";
import type { CardState } from "./module.tsx";
import { PairPick } from "./pair.tsx";

const classes = (...list: unknown[]) => list.filter(Boolean).join(" ");
const useHead = () => {
  const app = useApp();
  const card = useModule<CardState>();
  return app.use(() => card.device.get().head);
};

function Lamp({ s }: { s: SessionRecord | undefined }) {
  if (!s) return <Dot className="cw-lamp" kind="stop" role="img" title="не на связи" aria-label="не на связи" />;
  const why = failText(s);
  const title = s.state === "failed" && why ? `не запустилась: ${why}` : stateLabel(s.state).text;
  return <Dot className="cw-lamp" kind={lamp(s)} role="img" tabIndex={0} data-tip={title} title={title} aria-label={title} />;
}

function NameBtn({ callsign, names }: { callsign: string; names(): void }) {
  const app = useApp();
  const head = useHead();
  const name = app.use(() => sessionLabel(app, callsign));
  const place = app.use(() => machineLabel(app, machineOf(callsign)!));
  return (
    <IconBtn className="cw-nm" data-act="names" aria-label="Имена сессии и машины" title={callsign} onClick={names}>
      <b className={classes("cw-cs", name.human && "hum")}>{name.text}</b>
      {head.hat && <span className={classes("cw-at", place.human && "hum")}>{place.text}</span>}
    </IconBtn>
  );
}

/** Короткие настройки: нажатие ведёт туда, где они меняются и видны целиком. */
function Facts({ s, accounts, pick }: { s: SessionRecord; accounts: AccountsAnswer | undefined; pick(k: string): void }) {
  const app = useApp();
  const head = useHead();
  const owner = typeof s.by === "string" ? userOf(s.by) : null;
  const profile = profileNameOf(s);
  const model = [s.model, effortName(s.effort)].filter(Boolean).join(" · ");
  const wait = slotOf(s)?.wait;
  const five = accounts?.accounts?.[String(s.account)]?.limits?.five_hour;
  const used = five ? Math.round(five.utilization * 100) : 0;
  const account = [s.account, wait ? `ждёт сброса ${at(wait)}` : five ? `${used} %` : ""].filter(Boolean).join(" · ");
  return (
    <>
      {head.howner && owner && owner !== myAddress(app) && <span className="cw-pill">{owner.slice(1)}</span>}
      {head.hprof && profile && (
        <span className="cw-pill" title={profile}>
          {profile}
        </span>
      )}
      {head.hmodel && model && (
        <Btn className="cw-hb" data-go="set" title={model} onClick={() => pick("set")}>
          {model}
        </Btn>
      )}
      {head.hacc && account && (
        <Btn className={classes("cw-hb", wait ? "you" : used >= LIMIT_WARN && "lim")} data-go="info" title={account} onClick={() => pick("info")}>
          {account}
        </Btn>
      )}
    </>
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
  const s = app.use(() => sessionOf(app, callsign));
  const placed = app.use(() => app.placed("card.menu", { callsign }));
  const wing = app.use(() => wingOf(app.roster()?.sessions ?? [], callsign));
  return (
    <div className="cw-h">
      <Lamp s={s} />
      <NameBtn callsign={callsign} names={names} />
      {!s ? <span className="cw-note">не на связи</span> : wing ? <PairPick lead={s} wing={wing} /> : <Facts s={s} accounts={accounts} pick={pick} />}
      <span className="cw-gap" />
      <Tabs className="cw-tabs" tabs={tabs} cur={tab} pick={pick} />
      {placed.map((p) => (
        <Btn key={p.name} data-screen={p.name} onClick={() => app.run(p.name, { callsign })}>
          {p.label}
        </Btn>
      ))}
      {s && <Start callsign={callsign} s={s} />}
    </div>
  );
}
