// Шапка широкой карточки: лампа, имя, модель и аккаунт с их окнами, меню сессии. Группа «Шапка» панели вида.
import { useEffect } from "react";
import { machineOf, userOf } from "@switchboard/protocol";
import { Btn, Chip, Choices, Dot, effortName, EFFORTS, failText, IconBtn, incidentOf, LIMIT_NAMES, LIMIT_WARN, LimitRow, lamp, machineLabel, MODELS, myAddress, profileNameOf, remoteOf, RowBtn, sessionLabel, slotOf, stateLabel, at, type AccountsAnswer, type ModelInfo, useApp, useModule } from "@switchboard/web-ui";
import type { SessionRecord } from "@switchboard/relay";
import { DEFAULT_HEAD, type CardState } from "./state.ts";

const cx = (...names: unknown[]) => names.filter(Boolean).join(" ");
const UNITS: Array<[string, string, string]> = [["haddr", "Адрес", "Адрес сессии"], ["howner", "Владелец", "Владелец в шапке"], ["hprof", "Профиль", "Профиль в шапке"], ["hmodel", "Модель", "Модель и усилие в шапке"]];

/** Группа «Шапка» в панели вида «Работы». */
export function HeadUnits() {
  const app = useApp();
  const card = useModule<CardState>();
  const head = app.use(() => card.get().head);
  return (
    <Choices title="Шапка">
      {UNITS.map(([key, label, full]) => (
        <Chip key={key} on={head[key] ?? DEFAULT_HEAD[key]} data-v={key} aria-label={full} onClick={() => card.setHead({ ...head, [key]: !head[key] })}>
          {label}
        </Chip>
      ))}
    </Choices>
  );
}

type Pop = "model" | "acc" | "menu" | null;

function Windows({ session, accounts, machine, pickSlot }: { session: SessionRecord; accounts?: AccountsAnswer; machine: string; pickSlot(): void }) {
  const account = String(session.account ?? "");
  const info = accounts?.accounts?.[account];
  const slot = slotOf(session)?.name ?? "";
  const order = accounts?.slots?.[slot]?.order ?? [];
  return (
    <div className="cw-pop l w" role="dialog" aria-label="Аккаунт и лимиты">
      <dl className="cw-kv">
        <dt>аккаунт</dt>
        <dd>{[info?.email ?? account, info?.plan].filter(Boolean).join(" · ")}</dd>
        <dt>слот</dt>
        <dd>{`${slot} @${machine}`}</dd>
      </dl>
      {Object.entries(info?.limits ?? {}).map(([k, w]) => (
        <LimitRow key={k} className="cw-win" data-win={k} label={LIMIT_NAMES[k] ?? k} used={w.utilization} resets={w.resetsAt} />
      ))}
      {order.length ? <div className="cw-note queue">{`очередь слота: ${order.join(" → ")}`}</div> : null}
      <div className="cw-opts">
        <Btn onClick={pickSlot}>Сменить слот</Btn>
      </div>
    </div>
  );
}

export function Head({ callsign, session, accounts, tabs, pop, setPop, openNames, setTab, start, update }: {
  callsign: string;
  session?: SessionRecord;
  accounts?: AccountsAnswer;
  tabs: React.ReactNode;
  pop: Pop;
  setPop(p: Pop): void;
  openNames(): void;
  setTab(t: string): void;
  start(): void;
  update(field: "model" | "effort", value: string): void;
}) {
  const app = useApp();
  const card = useModule<CardState>();
  const head = app.use(() => card.get().head);
  const info = app.use(() => card.get().info);
  const machine = machineOf(callsign) ?? "";
  const name = app.use(() => sessionLabel(app, callsign));
  const where = app.use(() => machineLabel(app, machine));
  const models = app.use(() => app.mark("models", callsign) as ModelInfo[] | null | undefined);
  const placed = app.use(() => app.placed("card.menu", { callsign }));
  const canStart = app.use(() => app.can(machine, "session.start") === true);
  const canUpdate = app.use(() => app.can(machine, "session.update") === true);

  // окно закрывается щелчком мимо и Esc
  useEffect(() => {
    if (!pop) return;
    const onClick = (e: Event) => {
      if (!(e.target as Element).closest?.(".cw-pop, [data-pop]")) setPop(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPop(null);
    };
    document.addEventListener("click", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("click", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [pop, setPop]);

  const hum = (human: boolean) => (human ? "hum" : "");
  const nameBtn = (
    <IconBtn className="cw-nm" data-act="names" aria-label="Имена сессии и машины" onClick={openNames}>
      <span className="cw-nm1">
        <b className={cx("cw-cs", hum(name.human))}>{name.text}</b>
        <span className={cx("cw-at", hum(where.human))}>{where.text}</span>
        <span className="cw-ed" aria-hidden="true">
          ✎
        </span>
      </span>
      {session && head.haddr ? <span className="cw-real">{callsign}</span> : null}
    </IconBtn>
  );
  if (!session) {
    return (
      <div key="gone" className="cw-h">
        <div className="cw-hl">
          <Dot kind="stop" className="cw-lamp" role="img" title="не на связи" aria-label="не на связи" />
          {nameBtn}
          <span className="cw-note">не на связи</span>
        </div>
        <div className="cw-hr">{tabs}</div>
      </div>
    );
  }

  const failed = failText(session);
  const title = session.state === "failed" && failed ? `не запустилась: ${failed}` : stateLabel(session.state).text;
  const stopped = session.state === "stopped" || session.state === "failed";
  const owner = typeof session.by === "string" ? userOf(session.by) : null;
  const slot = slotOf(session);
  const accountInfo = accounts?.accounts?.[String(session.account ?? "")];
  const window5 = accountInfo?.limits?.five_hour;
  const used = window5 ? Math.round(window5.utilization * 100) : 0;
  const accountText = [String(session.account ?? ""), slot?.wait ? `ждёт сброса ${at(slot.wait)}` : window5 ? `${used} %` : ""].filter(Boolean).join(" · ");
  const modelList = models?.length ? models : MODELS.map((value) => ({ value, displayName: undefined }));
  const toggle = (p: Pop) => setPop(pop === p ? null : p);

  return (
    <div className="cw-h">
      <div className="cw-hl">
        <Dot kind={lamp(session)} className="cw-lamp" role="img" tabIndex={0} data-tip={title} title={title} aria-label={title} />
        {nameBtn}
        <span className="cw-meta">
          {head.howner && owner && owner !== myAddress(app) ? <span className="cw-pill">{owner.slice(1)}</span> : null}
          {head.hprof && profileNameOf(session) ? <span className="cw-pill">{profileNameOf(session)}</span> : null}
        </span>
        <span className="cw-hpw">
          {head.hmodel ? (
            <Btn
              className="cw-hb"
              data-pop="model"
              disabled={!canUpdate}
              aria-expanded={pop === "model"}
              onClick={() => {
                toggle("model");
                app.run("models.load", { callsign });
              }}
            >
              {`${[session.model, session.effort ? effortName(session.effort) : ""].filter(Boolean).join(" · ") || "модель"} ▾`}
            </Btn>
          ) : null}
          {session.account ? (
            <Btn className={cx("cw-hb", slot?.wait ? "you" : used >= LIMIT_WARN && "lim")} data-pop="acc" aria-expanded={pop === "acc"} onClick={() => toggle("acc")}>
              {`${accountText} ▾`}
            </Btn>
          ) : null}
          {pop === "model" ? (
            <div className="cw-pop l" role="dialog" aria-label="Модель и усилие">
              <span className="lb">Модель</span>
              {modelList.map((m) => (
                <RowBtn key={m.value} className="cw-mi" role="menuitemradio" aria-checked={session.model === m.value} data-model={m.value} onClick={() => update("model", m.value)}>
                  {`${session.model === m.value ? "✓ " : ""}${m.displayName ?? m.value}`}
                </RowBtn>
              ))}
              <span className="lb">Усилие</span>
              <div className="cw-opts">
                {EFFORTS.map(([k, label]) => (
                  <Btn key={k} aria-pressed={session.effort === k ? "true" : "false"} data-effort={k} onClick={() => update("effort", k)}>
                    {label}
                  </Btn>
                ))}
              </div>
            </div>
          ) : null}
          {pop === "acc" ? (
            <Windows
              session={session}
              accounts={accounts}
              machine={machine}
              pickSlot={() => {
                setPop(null);
                setTab("set");
              }}
            />
          ) : null}
        </span>
      </div>
      <div className="cw-hr">
        {tabs}
        {stopped && canStart ? (
          <Btn pri onClick={start}>
            Запустить
          </Btn>
        ) : null}
        {placed.map((p) => (
          <Btn key={p.name} data-screen={p.name} onClick={() => app.run(p.name, { callsign })}>
            {p.label}
          </Btn>
        ))}
        <span className="cw-mw">
          <Btn ghost className="cw-more" data-pop="menu" aria-label="Действия сессии" aria-haspopup="menu" aria-expanded={pop === "menu"} onClick={() => toggle("menu")}>
            ⋯
          </Btn>
          {pop === "menu" ? (
            <div className="cw-pop r" role="menu" aria-label={`Сессия ${callsign}`}>
              <dl className="cw-kv">
                {profileNameOf(session) ? (
                  <>
                    <dt>профиль</dt>
                    <dd>{profileNameOf(session)}</dd>
                  </>
                ) : null}
                {session.dir ? (
                  <>
                    <dt>папка</dt>
                    <dd>{String(session.dir)}</dd>
                  </>
                ) : null}
                <dt>машина</dt>
                <dd>{`@${machine}`}</dd>
                {incidentOf(session) ? (
                  <>
                    <dt>инцидент</dt>
                    <dd>{`${incidentOf(session)!.type} · ${incidentOf(session)!.key}`}</dd>
                  </>
                ) : null}
              </dl>
              <hr />
              <RowBtn
                className="cw-mi"
                role="menuitemcheckbox"
                aria-checked={info}
                data-act="info"
                onClick={() => {
                  card.setInfo(!info);
                  setPop(null);
                }}
              >
                Сведения сбоку
              </RowBtn>
              {remoteOf(session) ? (
                <a className="cw-mi" href={remoteOf(session)} target="_blank" rel="noopener" role="menuitem">
                  Открыть в claude.ai ↗
                </a>
              ) : null}
            </div>
          ) : null}
        </span>
      </div>
    </div>
  );
}

