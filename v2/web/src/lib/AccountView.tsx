// Один вид аккаунта и его лимитов на всей странице: компактный — в строке очереди и у сессии, обычный (full) — в списке аккаунтов.
import { IconCalendarWeek, IconSparkles } from "@tabler/icons-react";
import { limitTone, meterOf, slotModelWord, type LimitRow } from "./accounts.ts";
import { leftWord, resetWord } from "./time.ts";

/** Два запаса аккаунта двумя полосками: Fable и остальные модели; рядом — сколько осталось до недельного сброса.
 *  watch — вид очереди: она следит за своим запасом, чужой приглушён. */
export function Meter({ limits, full, watch }: { limits: LimitRow[]; full?: boolean; watch?: string }) {
  const { fable, other } = meterOf(limits);
  const now = Date.now();
  const reset = fable?.resets ?? other?.resets;
  const row = (l: LimitRow | undefined, icon: React.ReactNode, word: string, off?: boolean) => {
    const tone = l ? limitTone(l.used) : "teal";
    return (
      <span className={`meter-row ${tone}${off ? " off" : ""}`} title={l ? `${word}: ${Math.round(l.used * 100)}%` : `${word}: замера нет`} data-limit={word}>
        {icon}
        <span className="meter-bar" aria-hidden><i style={{ width: `${l ? Math.min(100, Math.round(l.used * 100)) : 0}%` }} /></span>
        <b>{l ? Math.round(l.used * 100) : "—"}</b>
      </span>
    );
  };
  return (
    <span className={full ? "meter full" : "meter"}>
      <span className="meter-rows">
        {row(fable, <IconSparkles size={11} aria-label="неделя Fable" />, "неделя Fable", watch !== undefined && watch !== "fable")}
        {row(other, <IconCalendarWeek size={11} aria-label="неделя, остальные модели" />, "неделя, остальные модели", watch === "fable")}
      </span>
      {reset !== undefined && reset > now && <span className="meter-left" title={`сброс ${resetWord(reset, now)}`}>{leftWord(reset, now)}</span>}
    </span>
  );
}

/** Очередь одной строкой: имя, модель и аккаунт, который стоит сейчас, с его лимитами — тот же вид, что на странице аккаунтов. */
export function SlotLine({ slot, account }: { slot: { name: string; model: string; account?: string; wait?: number }; account?: { limits?: LimitRow[]; ok: boolean; why?: string } }) {
  return (
    <span className="slotline">
      <span className="mono slot-name">{slot.name}</span>
      <span className="slot-model">{slotModelWord(slot.model)}</span>
      <AccountView name={slot.account ?? "пусто"} limits={account?.limits ?? []} watch={slot.model} bad={account && !account.ok ? account.why ?? "вход не годен" : undefined} />
      {slot.wait !== undefined && <span className="acct-wait">ждёт до {resetWord(slot.wait)}</span>}
    </span>
  );
}

export function AccountView({ name, plan, limits, bad, current, onPut, full, watch, children }: { name: React.ReactNode; plan?: string; limits: LimitRow[]; bad?: string; current?: boolean; /** поставить этот аккаунт в очередь: пустая лампа — кнопка */ onPut?: () => void; full?: boolean; watch?: string; children?: React.ReactNode }) {
  return (
    <div className={full ? "acct full" : "acct"}>
      <span className="acct-name">
        {current && <span className="lamp idle" style={{ marginTop: 0 }} role="img" aria-label="стоит сейчас" />}
        {onPut && <button type="button" className="lamp off put" style={{ marginTop: 0 }} aria-label="Поставить" title="Поставить" onClick={onPut} />}
        {bad && !full && <span className="acct-bad" title={bad} role="img" aria-label={bad}>⚠</span>}
        <span className="trunc" style={{ fontWeight: current || full ? 600 : 400 }}>{name}</span>
        {full && plan && <span className="muted" style={{ fontSize: 12 }}>{plan}</span>}
      </span>
      <Meter limits={limits} full={full} watch={watch} />
      {bad && full && <span className="acct-bad">{bad}</span>}
      {children}
    </div>
  );
}
