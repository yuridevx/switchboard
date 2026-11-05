// Шапка широкой карточки — одна строка: лампа, имя, «модель · усилие ▾», «аккаунт · % ▾», вкладки, «Запустить», «⋯». Окна шапки живут здесь.
import { useEffect, useRef, useState } from "react";
import type { SessionRecord } from "@switchboard/web-core";
import { at, Btn, Dot, effortName, failText, IconBtn, LIMIT_WARN, machineLabel, myAddress, profileNameOf, sessionLabel, slotOf, stateLabel, Tabs, useApp } from "@switchboard/web-ui";
import { userOf } from "@switchboard/protocol";
import { AccPop, MenuPop, ModelPop } from "./pops.tsx";
import { isDown, useSessionActions, type Can } from "./session.tsx";
import { useCard } from "./state.ts";
import type { WideData } from "./wide.tsx";

type Pop = "" | "model" | "acc" | "menu";
type Props = { callsign: string; machine: string; s: SessionRecord | undefined; can: Can; data: WideData; tabs: Array<[string, string]>; tab: string; select(k: string): void; openNames(): void };

/** Имя сессии и машины: нажатие открывает окно «Имена». */
function NameButton({ callsign, machine, openNames }: Pick<Props, "callsign" | "machine" | "openNames">) {
  const app = useApp();
  const card = useCard();
  const view = app.use(card.head);
  const name = app.use(() => sessionLabel(app, callsign));
  const host = app.use(() => machineLabel(app, machine));
  return (
    <IconBtn className="cw-nm" data-act="names" aria-label="Имена сессии и машины" onClick={openNames}>
      <span className="cw-nm1">
        <b className={"cw-cs" + (name.human ? " hum" : "")}>{name.text}</b>
        <span className={"cw-at" + (host.human ? " hum" : "")}>{host.text}</span>
        <span className="cw-ed" aria-hidden="true">
          ✎
        </span>
      </span>
      {view.haddr && (name.human || host.human) ? <span className="cw-real">{callsign}</span> : null}
    </IconBtn>
  );
}

/** Строка живой сессии: кто, модель, аккаунт и действия. */
function LiveHead({ callsign, machine, x, can, data, tabs, tab, select, openNames, pop, setPop }: Omit<Props, "s"> & { x: SessionRecord; pop: Pop; setPop(p: Pop): void }) {
  const app = useApp();
  const card = useCard();
  const view = app.use(card.head);
  const info = app.use(card.info);
  const me = app.use(() => myAddress(app));
  const menu = app.use(() => app.placed("card.menu", { callsign }));
  const actions = useSessionActions(callsign);

  function toggle(p: Exclude<Pop, "">) {
    const next = pop === p ? "" : p;
    setPop(next);
    if (next === "acc") data.reloadAccounts();
  }

  const { text: label, dot } = stateLabel(x.state);
  const why = failText(x);
  const tip = x.state === "failed" && why ? `${label}: ${why}` : label;
  const slot = slotOf(x);
  const limit = data.accounts?.[String(x.account ?? "")]?.limits?.five_hour;
  const accText = slot?.wait ? `ждёт сброса ${at(slot.wait)}` : limit ? `${Math.round(limit.utilization * 100)} %` : "";
  const accCls = slot?.wait ? "you" : limit && limit.utilization * 100 >= LIMIT_WARN ? "lim" : "";
  const owner = typeof x.by === "string" ? userOf(x.by) : null;
  const prof = profileNameOf(x);
  // слева кто, справа вкладки и действия: не помещаются в строку — вкладки уходят второй строкой
  return (
    <>
      <div className="cw-hl">
        <Dot kind={dot} className="cw-lamp" tabIndex={0} role="img" title={tip} aria-label={tip} data-tip={tip} />
        <NameButton callsign={callsign} machine={machine} openNames={openNames} />
        <span className="cw-meta">
          {view.howner && owner && owner !== me ? <span className="cw-pill">{owner.slice(1)}</span> : null}
          {view.hprof && prof ? <span className="cw-pill">{prof}</span> : null}
        </span>
        <span className="cw-hpw">
          {view.hmodel && (x.model || can("session.update")) ? (
            <Btn className="cw-hb" data-pop="model" aria-expanded={pop === "model" ? "true" : "false"} disabled={!can("session.update")} onClick={() => toggle("model")}>
              {`${[x.model, x.effort ? effortName(x.effort) : null].filter(Boolean).join(" · ") || "модель"} ▾`}
            </Btn>
          ) : null}
          {x.account ? (
            <Btn className={`cw-hb ${accCls}`} data-pop="acc" aria-expanded={pop === "acc" ? "true" : "false"} onClick={() => toggle("acc")}>
              {`${[x.account, accText].filter(Boolean).join(" · ")} ▾`}
            </Btn>
          ) : null}
          {pop === "model" ? (
            <ModelPop
              s={x}
              callsign={callsign}
              update={(body, what) => {
                setPop("");
                void actions.update(body, what);
              }}
            />
          ) : pop === "acc" ? (
            <AccPop
              s={x}
              machine={machine}
              accounts={data.accounts}
              slots={data.slots}
              word={data.word}
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
        <Tabs className="cw-tabs" tabs={tabs} cur={tab} pick={select} />
        {isDown(x) && can("session.start") ? (
          <Btn pri onClick={() => void actions.start()}>
            Запустить
          </Btn>
        ) : null}
        {menu.map((m) => (
          <Btn key={m.name} data-screen={m.name} onClick={() => app.run(m.name, { callsign })}>
            {m.label}
          </Btn>
        ))}
        <span className="cw-mw">
          <Btn ghost className="cw-more" data-pop="menu" aria-haspopup="menu" aria-expanded={pop === "menu" ? "true" : "false"} aria-label="Действия сессии" onClick={() => toggle("menu")}>
            ⋯
          </Btn>
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
  /** открытое окно шапки */
  const [pop, setPop] = useState<Pop>("");
  // окна закрываются кликом мимо и Esc; клик внутри шапки помечает её обработчик — он срабатывает раньше слушателя документа
  const inHead = useRef<Event | null>(null);
  useEffect(() => {
    const ac = new AbortController();
    document.addEventListener("click", (e) => e !== inHead.current && setPop(""), ac);
    document.addEventListener("keydown", (e) => e.key === "Escape" && setPop(""), ac);
    return () => ac.abort();
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
            <Tabs className="cw-tabs" tabs={p.tabs} cur={p.tab} pick={p.select} />
          </div>
        </>
      )}
    </div>
  );
}
