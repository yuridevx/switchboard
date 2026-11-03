// Общие части карточек: окна лимитов, строка итога, пометка общего аккаунта, отказы владельцев.
import { Hint, LIMIT_NAMES, LimitRow, Note, Outcome, useApp } from "@switchboard/web-ui";
import { useAccounts, useScreen } from "./context.ts";
import { slotsWith, type Account } from "./store.ts";

export function Windows({ a }: { a: Account | undefined }) {
  return (
    <>
      {Object.entries(a?.limits ?? {}).map(([k, w]) => (
        <LimitRow key={k} className="ac-w" data-window={k} label={LIMIT_NAMES[k] ?? k} used={w.utilization} resets={w.resetsAt} />
      ))}
    </>
  );
}

/** Строка итога действия. */
export function NoteLine({ k }: { k: string }) {
  return <Outcome note={useScreen().notes[k]} data-note={k} />;
}

/** Пометка «сейчас и в слоте …» — аккаунт стоит и в других слотах машины, лимит у них общий. */
export function Shared({ m, account, except }: { m: string; account: string; except: string }) {
  const app = useApp();
  const store = useAccounts();
  const list = app.use(() => store.slotsOf(m));
  const other = slotsWith(list ?? {}, account).filter((n) => n !== except);
  return other.length ? <Hint data-shared={other.join(",")}>{` · сейчас и в ${other.length > 1 ? "слотах" : "слоте"} ${other.join(", ")}`}</Hint> : null;
}

/** Отказы владельца запроса: all — выборка строк «машина · запрос». */
export function Refused({ only }: { only(key: string): boolean }) {
  const app = useApp();
  const store = useAccounts();
  const refused = app.use(store.refused);
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
