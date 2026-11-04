// Окна шапки широкой карточки: модель и усилие, аккаунт и лимиты, меню «⋯».
import type { AccountsAnswer, ModelInfo } from "@switchboard/web-ui";
import type { SessionRecord } from "@switchboard/web-core";
import { useEffect } from "react";
import { Btn, EFFORTS, incidentOf, isLive, LIMIT_NAMES, LimitRow, MODELS, Note, profileNameOf, remoteOf, RowBtn, slotOf, useApp } from "@switchboard/web-ui";

/** Строка «подпись — значение» списка сведений. */
export function Kv({ k, v }: { k: string; v: string }) {
  return (
    <>
      <dt>{k}</dt>
      <dd>{v}</dd>
    </>
  );
}

export function ModelPop({ s, callsign, update }: { s: SessionRecord; callsign: string; update(body: Record<string, unknown>, what: string): void }) {
  // модели — ответ SDK, владелец — чат: один запрос на разговор; пока ответа нет или сессия не живая — известный список
  const app = useApp();
  const asked = app.use(() => app.mark("models", callsign));
  const live = isLive(s.state);
  useEffect(() => {
    if (live) app.run("models.load", { callsign });
  }, [app, callsign, live]);
  const list: ModelInfo[] = asked?.length ? asked : MODELS.map((m) => ({ value: m }));
  return (
    <div className="cw-pop l" role="dialog" aria-label="Модель и усилие">
      <span className="lb">Модель</span>
      {list.map((m) => (
        <RowBtn key={m.value} className="cw-mi" role="menuitemradio" aria-checked={m.value === s.model ? "true" : "false"} data-model={m.value} onClick={() => update({ model: m.value }, "модель")}>
          {`${m.value === s.model ? "✓ " : ""}${m.displayName ?? m.value}`}
        </RowBtn>
      ))}
      <span className="lb">Усилие</span>
      <div className="cw-opts">
        {EFFORTS.map(([k, l]) => (
          <Btn key={k} aria-pressed={s.effort === k ? "true" : "false"} data-effort={k} onClick={() => update({ effort: k }, "усилие")}>
            {l}
          </Btn>
        ))}
      </div>
    </div>
  );
}

export function AccPop({ s, machine, accounts, slots, word, canSlot, changeSlot }: { s: SessionRecord; machine: string; accounts: AccountsAnswer["accounts"] | null; slots: AccountsAnswer["slots"] | null; word: string; canSlot: boolean; changeSlot(): void }) {
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
      {word && !accounts ? <Note tone="bad" data-refused="acc">{word}</Note> : null}
      {Object.entries(a?.limits ?? {}).map(([k, w]) => (
        <LimitRow key={k} className="cw-win" data-win={k} label={LIMIT_NAMES[k] ?? k} used={w.utilization} resets={w.resetsAt} />
      ))}
      {queue.length ? <div className="cw-note queue">{`очередь слота: ${queue.join(" → ")}`}</div> : null}
      {canSlot ? (
        <div className="cw-opts">
          <Btn onClick={changeSlot}>
            Сменить слот
          </Btn>
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
      <RowBtn className="cw-mi" role="menuitemcheckbox" aria-checked={info ? "true" : "false"} data-act="info" onClick={toggleInfo}>
        {`${info ? "✓ " : ""}Сведения сбоку`}
      </RowBtn>
      {remote ? (
        <a className="cw-mi" role="menuitem" href={remote} target="_blank" rel="noopener">
          Открыть в claude.ai ↗
        </a>
      ) : null}
    </div>
  );
}
