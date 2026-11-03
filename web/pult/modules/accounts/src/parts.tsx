// Общие части карточек: окна лимитов, строка итога, пометка общего аккаунта, отказы владельцев.
import { useApp } from "@switchboard/web-core";
import { Hint, hhmm, Meter, Note } from "@switchboard/web-ui";
import { useAccounts, useScreen } from "./context.ts";
import { slotsWith, type Account } from "./store.ts";

/** Окна лимитов: подпись. */
export const WIN: Record<string, string> = { five_hour: "5 ч", seven_day: "неделя", seven_day_opus: "неделя opus", seven_day_sonnet: "неделя sonnet" };

export function Windows({ a }: { a: Account | undefined }) {
  return (
    <>
      {Object.entries(a?.limits ?? {}).map(([k, w]) => {
        const pct = Math.round(w.utilization * 100);
        return (
          <div key={k} className="ac-w" data-window={k}>
            <span>{WIN[k] ?? k}</span>
            <Meter value={Math.min(100, pct)} bad={pct >= 90} warn={pct < 90 && pct >= 70} />
            <em>{`${pct} %${w.resetsAt ? " · до " + hhmm(w.resetsAt * 1000) : ""}`}</em>
          </div>
        );
      })}
    </>
  );
}

/** Строка итога действия. */
export function NoteLine({ k }: { k: string }) {
  const n = useScreen().notes[k];
  return n?.text ? (
    <Note tone={n.tone} role="status" data-note={k}>
      {n.text}
    </Note>
  ) : null;
}

/** Пометка «сейчас и в слоте …» — аккаунт стоит и в других слотах машины, лимит у них общий. */
export function Shared({ m, account, except }: { m: string; account: string; except: string }) {
  const app = useApp();
  const store = useAccounts();
  const list = app.use(() => store.state().slots[m]);
  const other = slotsWith(list ?? {}, account).filter((n) => n !== except);
  return other.length ? <Hint data-shared={other.join(",")}>{` · сейчас и в ${other.length > 1 ? "слотах" : "слоте"} ${other.join(", ")}`}</Hint> : null;
}

/** Отказы владельца запроса: all — выборка строк «машина · запрос». */
export function Refused({ only }: { only(key: string): boolean }) {
  const app = useApp();
  const store = useAccounts();
  const refused = app.use(() => store.state().refused);
  return (
    <>
      {Object.entries(refused)
        .filter(([k]) => only(k))
        .map(([k, w]) => (
          <Note key={k} tone="bad" role="alert" data-refused={k}>{`${k}: ${w}`}</Note>
        ))}
    </>
  );
}
