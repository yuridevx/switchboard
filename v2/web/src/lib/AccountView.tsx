// Один вид аккаунта и его лимитов на всей странице: компактный — в строке очереди и у сессии, обычный (full) — в списке аккаунтов.
import type { Lane } from "@sb/protocol";
import { IconCalendarWeek, IconSparkles } from "@tabler/icons-react";
import { limitTone, meterOf, type LimitRow } from "./accounts.ts";
import { leftWord, resetWord } from "./time.ts";

/** Какие места очереди стоят на этом аккаунте. */
export type Stands = Partial<Record<Lane, boolean>>;

/** Два числа аккаунта двумя полосками, как на странице Claude: неделя и Fable; рядом — сколько осталось до недельного сброса.
 *  Неделя — в два тона: светлее то, что потратил Fable, плотнее — остальные модели; штрих в конце — запас, который держится для Fable.
 *  stands — строка очереди: у полоски лампа места (у недели — остальные модели, у Fable — Fable); пустая лампа с onPut — кнопка «поставить». */
export function Meter({ limits, full, stands, onPut }: { limits: LimitRow[]; full?: boolean; stands?: Stands; onPut?: (lane: Lane) => void }) {
  const { week, fable } = meterOf(limits);
  const now = Date.now();
  const reset = week?.resets ?? fable?.resets;
  const pct = (x: number) => `${Math.max(0, Math.min(100, Math.round(x * 100)))}%`;
  const lamp = (lane: Lane, word: string) =>
    !stands ? null : stands[lane] ? <span className="lamp idle lane" role="img" aria-label={`${word}: стоит здесь`} title={`${word}: стоит здесь`} data-lane={lane} />
      : onPut ? <button type="button" className="lamp off put lane" aria-label={`Поставить: ${word}`} title={`Поставить: ${word}`} data-lane={lane} onClick={() => onPut(lane)} />
        : <span className="lamp off lane" aria-hidden />;
  const row = (l: LimitRow | undefined, lane: Lane, icon: React.ReactNode, word: string) => {
    const tone = l ? limitTone(l.used) : "teal";
    const share = l?.fable ?? 0;
    return (
      <span className={`meter-row ${tone}`} title={l ? `${word}: ${Math.round(l.used * 100)}%` : `${word}: замера нет`} data-limit={word}>
        {lamp(lane, lane === "fable" ? "Fable" : "остальные модели")}
        {icon}
        <span className="meter-bar" aria-hidden>
          {l && share > 0 && <i className="share" style={{ width: pct(share) }} />}
          <i style={{ width: l ? pct(l.used - share) : 0 }} />
          {l?.hold ? <i className="hold" style={{ width: pct(l.hold) }} /> : null}
        </span>
        <b>{l ? Math.round(l.used * 100) : "—"}</b>
      </span>
    );
  };
  return (
    <span className={full ? "meter full" : "meter"}>
      <span className="meter-rows">
        {row(week, "other", <IconCalendarWeek size={11} aria-label="неделя, все модели" />, "неделя, все модели")}
        {row(fable, "fable", <IconSparkles size={11} aria-label="неделя Fable" />, "неделя Fable")}
      </span>
      {reset !== undefined && reset > now && <span className="meter-left" title={`сброс ${resetWord(reset, now)}`}>{leftWord(reset, now)}</span>}
    </span>
  );
}

/** Очередь одной строкой: имя и аккаунт, на котором стоит место сессии, с его лимитами — тот же вид, что на странице аккаунтов. */
export function SlotLine({ slot, lane, account }: { slot: { name: string; lanes: Record<Lane, { account?: string; wait?: number }> }; lane: Lane; account?: { limits?: LimitRow[]; ok: boolean; why?: string } }) {
  const at = slot.lanes[lane];
  return (
    <span className="slotline">
      <span className="mono slot-name">{slot.name}</span>
      <AccountView name={at.account ?? "пусто"} limits={account?.limits ?? []} bad={account && !account.ok ? account.why ?? "вход не годен" : undefined} />
      {at.wait !== undefined && <span className="acct-wait">ждёт до {resetWord(at.wait)}</span>}
    </span>
  );
}

export function AccountView({ name, plan, limits, bad, stands, onPut, full, children }: { name: React.ReactNode; plan?: string; limits: LimitRow[]; bad?: string; /** строка очереди: какие места стоят на аккаунте */ stands?: Stands; /** поставить место на этот аккаунт */ onPut?: (lane: Lane) => void; full?: boolean; children?: React.ReactNode }) {
  const current = !!stands && (!!stands.fable || !!stands.other);
  return (
    <div className={full ? "acct full" : "acct"}>
      <span className="acct-name">
        {bad && !full && <span className="acct-bad" title={bad} role="img" aria-label={bad}>⚠</span>}
        <span className="trunc" style={{ fontWeight: current || full ? 600 : 400 }}>{name}</span>
        {full && plan && <span className="muted" style={{ fontSize: 12 }}>{plan}</span>}
      </span>
      <Meter limits={limits} full={full} stands={stands} onPut={onPut} />
      {bad && full && <span className="acct-bad">{bad}</span>}
      {children}
    </div>
  );
}
