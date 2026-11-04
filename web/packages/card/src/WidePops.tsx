// Окна шапки широкой карточки: модель и усилие, аккаунт и лимиты, меню «⋯».
import type { SessionRecord } from "@switchboard/web-core";
import { EFFORTS, isLive, LIMIT_NAMES, LimitRow, MODELS, profileNameOf, remoteOf, incidentOf, slotOf, useMachineLoad } from "@switchboard/web-ui";
import type { Acc, Model, SlotInfo } from "./session.ts";

/** Строка «подпись — значение» списка сведений. */
export function Kv({ k, v }: { k: string; v: string }) {
  return (
    <>
      <dt>{k}</dt>
      <dd>{v}</dd>
    </>
  );
}

export function ModelPop({ s, machine, callsign, update }: { s: SessionRecord; machine: string; callsign: string; update(body: Record<string, unknown>, what: string): void }) {
  // модели — ответ SDK на открытие окна; пока ответа нет или сессия не живая — известный список
  const { data } = useMachineLoad<Model[]>(machine, "session.call", { callsign, method: "supportedModels", args: [] }, isLive(s.state));
  const list: Model[] = Array.isArray(data) ? data : MODELS.map((m) => ({ value: m }));
  return (
    <div className="cw-pop l" role="dialog" aria-label="Модель и усилие">
      <span className="lb">Модель</span>
      {list.map((m) => (
        <button key={m.value} className="cw-mi" role="menuitemradio" aria-checked={m.value === s.model ? "true" : "false"} data-model={m.value} onClick={() => update({ model: m.value }, "модель")}>
          {`${m.value === s.model ? "✓ " : ""}${m.displayName ?? m.value}`}
        </button>
      ))}
      <span className="lb">Усилие</span>
      <div className="cw-opts">
        {EFFORTS.map(([k, l]) => (
          <button key={k} className="cw-b" aria-pressed={s.effort === k ? "true" : "false"} data-effort={k} onClick={() => update({ effort: k }, "усилие")}>
            {l}
          </button>
        ))}
      </div>
    </div>
  );
}

export function AccPop({ s, machine, accounts, slots, canSlot, changeSlot }: { s: SessionRecord; machine: string; accounts: Record<string, Acc> | null; slots: Record<string, SlotInfo> | null; canSlot: boolean; changeSlot(): void }) {
  const name = String(s.account ?? "");
  const a = accounts?.[name];
  const sl = slotOf(s);
  const queue = sl?.name ? (slots?.[sl.name]?.order ?? []) : [];
  return (
    <div className="cw-pop l w" role="dialog" aria-label="Аккаунт и лимиты">
      <dl className="cw-kv">
        <Kv k="аккаунт" v={[a?.email ?? name, a?.plan].filter(Boolean).join(" · ")} />
        {sl?.name ? <Kv k="слот" v={`${sl.name} @${machine}`} /> : null}
      </dl>
      {Object.entries(a?.limits ?? {}).map(([k, w]) => (
        <LimitRow key={k} className="cw-win" data-win={k} label={LIMIT_NAMES[k] ?? k} used={w.utilization} resets={w.resetsAt} />
      ))}
      {queue.length ? <div className="cw-note queue">{`очередь слота: ${queue.join(" → ")}`}</div> : null}
      {canSlot ? (
        <div className="cw-opts">
          <button className="cw-b" onClick={changeSlot}>
            Сменить слот
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function MenuPop({ s, machine, callsign, info, toggleInfo }: { s: SessionRecord; machine: string; callsign: string; info: boolean; toggleInfo(): void }) {
  const remote = remoteOf(s);
  const inc = incidentOf(s);
  return (
    <div className="cw-pop r" role="menu" aria-label={`Сессия ${callsign}`}>
      <dl className="cw-kv">
        <Kv k="профиль" v={profileNameOf(s) ?? "без профиля"} />
        {typeof s.dir === "string" ? <Kv k="папка" v={s.dir} /> : null}
        <Kv k="машина" v={`@${machine}`} />
        {inc?.type ? <Kv k="инцидент" v={[inc.type, inc.key].filter(Boolean).join(" · ")} /> : null}
      </dl>
      <hr />
      <button className="cw-mi" role="menuitemcheckbox" aria-checked={info ? "true" : "false"} data-act="info" onClick={toggleInfo}>
        {`${info ? "✓ " : ""}Сведения сбоку`}
      </button>
      {remote ? (
        <a className="cw-mi" role="menuitem" href={remote} target="_blank" rel="noopener">
          Открыть в claude.ai ↗
        </a>
      ) : null}
    </div>
  );
}
