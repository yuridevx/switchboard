// Шапка широкой карточки — одна строка: лампа, имя, «модель · усилие ▾», «аккаунт · % ▾», вкладки, «Запустить», «⋯». Окна шапки живут здесь.
import { useEffect, useRef, useState } from "react";
import { useApp, type SessionRecord } from "@switchboard/web-core";
import { at, Dot, effortName, failText, machineLabel, myAddress, profileName, profileNameOf, sessionLabel, stateLabel } from "@switchboard/web-ui";
import { userOf } from "@switchboard/protocol";
import { useCard } from "./context.ts";
import { isDown, slotOf, type Can } from "./session.ts";
import type { WideData } from "./useWideData.ts";
import { AccPop, MenuPop, ModelPop } from "./WidePops.tsx";

/** С этой доли окна 5 часов кнопка аккаунта жёлтая. */
const LIMIT_HINT = 0.7;

type Pop = "" | "model" | "acc" | "menu";
type Props = { callsign: string; machine: string; s: SessionRecord | undefined; can: Can; data: WideData; tabs: Array<[string, string]>; tab: string; select(k: string): void; openNames(): void };

/** Имя сессии и машины: нажатие открывает окно «Имена». */
function NameButton({ callsign, machine, openNames }: { callsign: string; machine: string; openNames(): void }) {
  const app = useApp();
  const card = useCard();
  const view = app.use(card.head);
  const name = app.use(() => sessionLabel(app, callsign));
  const host = app.use(() => machineLabel(app, machine));
  return (
    <button className="cw-nm" data-act="names" aria-label="Имена сессии и машины" onClick={openNames}>
      <span className="cw-nm1">
        <b className={"cw-cs" + (name.human ? " hum" : "")}>{name.text}</b>
        <span className={"cw-at" + (host.human ? " hum" : "")}>{host.text}</span>
        <span className="cw-ed" aria-hidden="true">
          ✎
        </span>
      </span>
      {view.haddr && (name.human || host.human) ? <span className="cw-real">{callsign}</span> : null}
    </button>
  );
}

function Tabs({ tabs, tab, select }: Pick<Props, "tabs" | "tab" | "select">) {
  return (
    <div className="cw-tabs" role="tablist">
      {tabs.map(([k, label]) => (
        <button key={k} role="tab" aria-selected={tab === k ? "true" : "false"} data-tab={k} onClick={() => select(k)}>
          {label}
        </button>
      ))}
    </div>
  );
}

/** Строка живой сессии: кто, модель, аккаунт и действия. */
function LiveHead({ callsign, machine, x, can, data, tabs, tab, select, openNames, pop, setPop }: Omit<Props, "s"> & { x: SessionRecord; pop: Pop; setPop(p: Pop): void }) {
  const app = useApp();
  const card = useCard();
  const view = app.use(card.head);
  const info = app.use(card.info);
  const myAddr = app.use(() => myAddress(app));
  const menuItems = app.use(() => app.placed("card.menu", { callsign }));

  function toggle(p: "model" | "acc" | "menu") {
    const next = pop === p ? "" : p;
    setPop(next);
    if (next === "model") void data.loadModels();
    if (next === "acc") data.reloadAccounts();
  }

  const { text: label, dot } = stateLabel(x.state);
  const why = failText(x);
  const tip = x.state === "failed" && why ? `${label}: ${why}` : label;
  const sl = slotOf(x);
  const w5 = data.accounts?.[String(x.account ?? "")]?.limits?.five_hour;
  const accText = sl?.wait ? `ждёт сброса ${at(sl.wait)}` : w5 ? `${Math.round(w5.utilization * 100)} %` : "";
  const accCls = sl?.wait ? "you" : w5 && w5.utilization >= LIMIT_HINT ? "lim" : "";
  const stopped = isDown(x);
  const owner = typeof x.by === "string" ? userOf(x.by) : null;
  const prof = profileNameOf(x);
  // слева кто, справа вкладки и действия: не помещаются в строку — вкладки уходят второй строкой
  return (
    <>
      <div className="cw-hl">
        <Dot kind={dot} className="cw-lamp" tabIndex={0} role="img" title={tip} aria-label={tip} data-tip={tip} />
        <NameButton callsign={callsign} machine={machine} openNames={openNames} />
        <span className="cw-meta">
          {view.howner && owner && owner !== myAddr ? <span className="cw-pill">{owner.slice(1)}</span> : null}
          {view.hprof && prof ? <span className="cw-pill">{prof}</span> : null}
        </span>
        <span className="cw-hpw">
          {view.hmodel && (x.model || can("session.update")) ? (
            <button className="cw-hb" data-pop="model" aria-expanded={pop === "model" ? "true" : "false"} disabled={!can("session.update")} onClick={() => toggle("model")}>
              {`${[x.model, x.effort ? effortName(x.effort) : null].filter(Boolean).join(" · ") || "модель"} ▾`}
            </button>
          ) : null}
          {x.account ? (
            <button className={`cw-hb ${accCls}`} data-pop="acc" aria-expanded={pop === "acc" ? "true" : "false"} onClick={() => toggle("acc")}>
              {`${[x.account, accText].filter(Boolean).join(" · ")} ▾`}
            </button>
          ) : null}
          {pop === "model" ? (
            <ModelPop
              s={x}
              models={data.models}
              update={(body, what) => {
                setPop("");
                void data.update(body, what);
              }}
            />
          ) : pop === "acc" ? (
            <AccPop
              s={x}
              machine={machine}
              accounts={data.accounts}
              slots={data.slots}
              canSlot={can("session.slot")}
              changeSlot={() => {
                setPop("");
                select("set");
              }}
            />
          ) : null}
        </span>
      </div>
      <div className="cw-hr">
        <Tabs tabs={tabs} tab={tab} select={select} />
        {stopped && can("session.start") ? (
          <button className="cw-b pri" onClick={() => void data.start()}>
            Запустить
          </button>
        ) : null}
        {/* пункты места card.menu: закрепление (web-board) */}
        {menuItems.map((m) => (
          <button key={m.screen} className="cw-b" data-screen={m.screen} onClick={() => app.open(m.screen, { from: callsign })}>
            {m.label}
          </button>
        ))}
        <span className="cw-mw">
          <button className="cw-b ghost cw-more" data-pop="menu" aria-haspopup="menu" aria-expanded={pop === "menu" ? "true" : "false"} aria-label="Действия сессии" onClick={() => toggle("menu")}>
            ⋯
          </button>
          {pop === "menu" ? (
            <MenuPop
              s={x}
              machine={machine}
              callsign={callsign}
              info={info}
              toggleInfo={() => {
                setPop("");
                card.setInfo(!card.info());
              }}
            />
          ) : null}
        </span>
      </div>
    </>
  );
}

export function WideHead(p: Props) {
  /** открытое окно шапки: модель, аккаунт или меню ⋯ */
  const [pop, setPop] = useState<Pop>("");
  // окна шапки закрываются кликом мимо и Esc; клик внутри шапки помечает её обработчик — он срабатывает раньше слушателя документа
  const inHead = useRef<Event | null>(null);
  useEffect(() => {
    const outside = (e: Event) => {
      if (e !== inHead.current) setPop("");
    };
    const esc = (e: Event) => {
      if ((e as KeyboardEvent).key === "Escape") setPop("");
    };
    document.addEventListener("click", outside);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("click", outside);
      document.removeEventListener("keydown", esc);
    };
  }, []);
  return (
    <div className="cw-h" onClick={(e) => (inHead.current = e.nativeEvent)}>
      {p.s ? (
        <LiveHead {...p} x={p.s} pop={pop} setPop={setPop} />
      ) : (
        <>
          <div className="cw-hl">
            <Dot kind="stop" className="cw-lamp" role="img" title="не на связи" aria-label="не на связи" />
            <NameButton callsign={p.callsign} machine={p.machine} openNames={p.openNames} />
            <span className="cw-note">не на связи</span>
          </div>
          <div className="cw-hr">
            <Tabs tabs={p.tabs} tab={p.tab} select={p.select} />
          </div>
        </>
      )}
    </div>
  );
}
