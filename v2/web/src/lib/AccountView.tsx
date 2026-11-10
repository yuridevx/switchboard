// Один вид аккаунта и его лимитов на всей странице: компактный — в строке очереди, обычный (full) — в списке аккаунтов.
import { limitTone, limitWord, sortLimits, type LimitRow } from "./accounts.ts";
import { hhmm, limitName, resetWord, untilWord } from "./time.ts";

/** Окна лимитов в ряд: имя, полоска, процент, сброс. Компактный вид называет сброс только у окна под порогом; обычный — всегда, с остатком времени. */
export function Limits({ limits, full }: { limits: LimitRow[]; full?: boolean }) {
  if (!limits.length) return null;
  const now = Date.now();
  // замер старше часа называется один раз на аккаунт — самым старым
  const old = Math.min(...limits.map((l) => l.at ?? now));
  return (
    <span className={full ? "lims full" : "lims"}>
      {sortLimits(limits).map((l) => {
        const tone = limitTone(l.used);
        return (
          <span key={l.name} className={`lim ${tone}`} title={`${limitName(l.name)}: ${limitWord(l, now)}`}>
            <span className="lim-name">{limitName(l.name)}</span>
            <span className="lim-bar" aria-hidden><i style={{ width: `${Math.min(100, Math.round(l.used * 100))}%` }} /></span>
            <b>{Math.round(l.used * 100)}%</b>
            {l.resets !== undefined && l.resets > now && (full || tone !== "teal") && <span className="lim-reset">до {resetWord(l.resets, now)}{full && <span className="lim-left"> · {untilWord(l.resets, now)}</span>}</span>}
          </span>
        );
      })}
      {full && now - old > 3_600_000 && <span className="lim-reset">замер {hhmm(old)}</span>}
    </span>
  );
}

/** Аккаунт одной строкой: имя, тариф (в обычном виде), лимиты, ожидание сброса, беда входа. name — узел имени: текст или кнопка. */
export function AccountView({ name, plan, limits, wait, bad, current, full, children }: { name: React.ReactNode; plan?: string; limits: LimitRow[]; wait?: number; bad?: string; current?: boolean; full?: boolean; children?: React.ReactNode }) {
  return (
    <div className={full ? "acct full" : "acct"}>
      <span className="acct-name">
        {current && <span className="lamp idle" style={{ marginTop: 0 }} role="img" aria-label="стоит сейчас" />}
        <span className="trunc" style={{ fontWeight: current || full ? 600 : 400 }}>{name}</span>
        {full && plan && <span className="muted" style={{ fontSize: 12 }}>{plan}</span>}
      </span>
      <Limits limits={limits} full={full} />
      {wait !== undefined && <span className="acct-wait">ждёт сброса до {resetWord(wait)}</span>}
      {bad && <span className="acct-bad">{bad}</span>}
      {children}
    </div>
  );
}
