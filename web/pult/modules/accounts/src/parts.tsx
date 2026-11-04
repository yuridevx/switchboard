// Общие части карточек: окна лимитов, строка итога, пометка общего аккаунта, отказы владельцев.
import { Hint, LIMIT_NAMES, LimitRow, Note, Outcome, useApp } from "@switchboard/web-ui";
import { useScreen } from "./screen.tsx";
import { slotsWith, type Account, useAccounts } from "./store.ts";

export function Windows({ account }: { account: Account | undefined }) {
  return (
    <>
      {Object.entries(account?.limits ?? {}).map(([name, w]) => (
        <LimitRow key={name} className="ac-w" data-window={name} label={LIMIT_NAMES[name] ?? name} used={w.utilization} resets={w.resetsAt} />
      ))}
    </>
  );
}

export function NoteLine({ k }: { k: string }) {
  return <Outcome note={useScreen().notes[k]} data-note={k} />;
}

/** «сейчас и в слоте …»: аккаунт стоит и в других слотах машины, лимит у них общий. */
export function Shared({ m, account, except }: { m: string; account: string; except: string }) {
  const app = useApp();
  const store = useAccounts();
  const slots = app.use(() => store.slotsOf(m));
  const other = slotsWith(slots ?? {}, account).filter((name) => name !== except);
  return other.length ? <Hint data-shared={other.join(",")}>{` · сейчас и в ${other.length > 1 ? "слотах" : "слоте"} ${other.join(", ")}`}</Hint> : null;
}

/** Отказы владельца запроса; only — выборка строк «машина · запрос». */
export function Refused({ only }: { only(key: string): boolean }) {
  const app = useApp();
  const store = useAccounts();
  const refused = app.use(store.refused);
  return (
    <>
      {Object.entries(refused)
        .filter(([key]) => only(key))
        .map(([key, word]) => (
          <Note key={key} tone="bad" role="alert" data-refused={key}>{`${key}: ${word}`}</Note>
        ))}
    </>
  );
}
