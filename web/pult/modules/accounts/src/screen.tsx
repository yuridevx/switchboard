// Страница «Аккаунты»: наверху лимиты каждого аккаунта, ниже машины строками, в строке очередь её аккаунтов. Всё, что нажато, открывается в этой строке.
import { useEffect, useState } from "react";
import { machineOf } from "@switchboard/protocol";
import { ago, at, type AccountsAnswer, Btn, day, Dot, hhmm, In, LIMIT_BAD, LIMIT_WARN, machineLabel, Meter, Note, okOf, Outcome, type OutcomeNote, Page, type SlotInfo, useApp, useOutcome, wordOf } from "@switchboard/web-ui";
import type { MachineRowInfo } from "../../machines/contract.ts";
import { type Merged, merged, order, resetText, shortName, type Win } from "./merge.ts";
import { refusal, useAccounts } from "./state.ts";

/** Что открыто под строкой: одно на странице. */
type Panel = { kind: "entry"; machine: string; slot: string; account: string } | { kind: "machine"; machine: string } | { kind: "diff"; account: string } | null;

const EXPIRES_SOON_S = 7 * 86400;
const nowS = () => Math.floor(Date.now() / 1000);
const peak = (windows: Win[]) => Math.round(Math.max(0, ...windows.map((w) => w.used)) * 100);
const tone = (percent: number) => (percent >= LIMIT_BAD ? "over" : percent >= LIMIT_WARN ? "warn" : "");
/** Значение старше часа подписано: остальные считаются свежими. */
const OLD_S = 3600;

function WindowLine({ w }: { w: Win }) {
  const percent = Math.round(w.used * 100);
  return (
    <div className={`ac-win ${tone(percent)}`} data-window={w.key}>
      <span>{w.name}</span>
      <Meter value={Math.min(percent, 100)} warn={tone(percent) === "warn"} bad={tone(percent) === "over"} />
      <b>{`${percent} %`}</b>
      <time title={w.at && nowS() - w.at > OLD_S ? `данные ${ago(w.at * 1000)}` : undefined}>
        {w.resets ? resetText(w.resets) : ""}
        {w.at && nowS() - w.at > OLD_S ? (
          <small data-age="">
            {" · "}
            <span className="w">от </span>
            {ago(w.at * 1000)}
          </small>
        ) : null}
      </time>
    </div>
  );
}

function AccountLine({ a, columns, marked, mark, panel, setPanel }: { a: Merged; columns: string[]; marked: boolean; mark(): void; panel: Panel; setPanel(p: Panel): void }) {
  const open = panel?.kind === "diff" && panel.account === a.email;
  return (
    <div className={marked ? "ac marked" : "ac"} data-account={a.email}>
      <span className="ac-id">
        <button type="button" className="ac-name" title={a.email} onClick={mark}>
          {shortName(a.email)}
        </button>
        {a.diff.length ? (
          <button type="button" className="ac-warn" aria-label={`Данные ${shortName(a.email)} на машинах расходятся`} title="Данные на машинах расходятся" aria-expanded={open} onClick={() => setPanel(open ? null : { kind: "diff", account: a.email })}>
            ⚠
          </button>
        ) : null}
      </span>
      <div className="ac-wins">
        {columns.map((key) => {
          const w = a.windows.find((x) => x.key === key);
          return w ? <WindowLine key={key} w={w} /> : <div key={key} className="ac-win empty" />;
        })}
      </div>
      {open ? (
        <div className="ac-inl" data-diff={a.email}>
          {a.diff.map((d) => (
            <div key={d.machines.join()} className="ac-diff">
              <b>{d.machines.join(", ")}</b>
              <span>{d.text}</span>
            </div>
          ))}
          <Btn onClick={() => setPanel(null)}>Закрыть</Btn>
        </div>
      ) : null}
    </div>
  );
}

/** Запись очереди: состояние — формой, процент — самое занятое окно аккаунта. */
function Entry({ machine, slot, info, email, windows, open, marked, toggle }: { machine: string; slot: SlotInfo; info: AccountsAnswer["accounts"][string] | undefined; email: string; windows: Win[]; open: boolean; marked: boolean; toggle(): void }) {
  const place = slot.order.indexOf(email);
  const off = info?.login !== "ok";
  const working = slot.account === email;
  const percent = peak(windows);
  const soon = info?.expires && info.expires - nowS() < EXPIRES_SOON_S ? `вход до ${day(info.expires * 1000)}` : "";
  const kind = off ? "none" : working ? "cur" : place >= 0 ? "res" : "free";
  return (
    <button type="button" className={`ac-entry ${kind}${open ? " open" : ""}${marked ? " marked" : ""}`} data-entry={`${machine}:${email}`} title={email} onClick={toggle}>
      {off ? <em>!</em> : working ? <em>●</em> : place >= 0 ? <em>{place + 1}</em> : null}
      {shortName(email)} {off ? "нет входа" : <span className={tone(percent)}>{`${percent} %`}</span>}
      {soon ? <small>{soon}</small> : null}
    </button>
  );
}

function EntryActions({ machine, slotName, slot, email, off, act, close }: { machine: string; slotName: string; slot: SlotInfo; email: string; off: boolean; act(kind: string): void; close(): void }) {
  const inOrder = slot.order.includes(email);
  const working = slot.account === email;
  return (
    <div className="ac-inl" data-actions={`${machine}:${slotName}:${email}`}>
      {off ? (
        <Btn pri onClick={() => act("login")}>
          Войти заново
        </Btn>
      ) : working ? (
        <Btn pri onClick={() => act("next")}>
          Сменить на следующего
        </Btn>
      ) : (
        <Btn pri onClick={() => act("now")}>
          Поставить сейчас
        </Btn>
      )}
      {!off && !working && inOrder ? <Btn onClick={() => act("up")}>Выше</Btn> : null}
      {!off && !working && inOrder ? <Btn onClick={() => act("down")}>Ниже</Btn> : null}
      {!off && !working && inOrder ? <Btn onClick={() => act("out")}>Убрать из очереди</Btn> : null}
      {!off && !working && !inOrder ? <Btn onClick={() => act("add")}>В очередь</Btn> : null}
      {!off ? <Btn onClick={() => act("login")}>Войти заново</Btn> : null}
      <Btn bad onClick={() => act("remove")}>
        Удалить с машины
      </Btn>
      <Btn onClick={close}>Закрыть</Btn>
    </div>
  );
}

function LoginPanel({ machine, note }: { machine: string; note(text: string, tone: OutcomeNote["tone"]): void }) {
  const state = useAccounts();
  const app = useApp();
  const card = app.use(() => state.logins()[machine]);
  const [code, setCode] = useState("");
  if (!card) return null;
  return (
    <div className="ac-inl" data-login={machine}>
      {card.url ? (
        <>
          <a className="sb-b pri ac-link" href={card.url} target="_blank" rel="noopener">
            Открыть ссылку входа ↗
          </a>
          <Btn onClick={() => void navigator.clipboard?.writeText(card.url!)}>Копировать</Btn>
          <In mono data-f="code" placeholder="Код со страницы" autoComplete="off" value={code} disabled={card.sending} onInput={(e) => setCode(e.currentTarget.value)} />
          <Btn
            pri
            disabled={card.sending}
            onClick={() =>
              void state.sendCode(machine, code).then((r) => {
                if (r) note(r.text, r.tone);
              })
            }
          >
            Отправить
          </Btn>
        </>
      ) : (
        <Note>…</Note>
      )}
      <Btn onClick={() => state.hideLogin(machine)}>Отмена</Btn>
    </div>
  );
}

function MachinePanel({ machine, answer, hasSessions, run, close }: { machine: string; answer: AccountsAnswer | undefined; hasSessions(slot: string): boolean; run(body: { slot: string; order: string[] }, done: string): void; close(): void }) {
  const app = useApp();
  const [name, setName] = useState("");
  const first = Object.entries(answer?.accounts ?? {}).find(([, a]) => a.login === "ok")?.[0];
  return (
    <div className="ac-inl" data-machine-panel={machine}>
      <div className="ac-wide">
        <app.Slot screen="machine.parts" params={{ machine }} />
      </div>
      {answer ? (
        <div className="ac-newslot">
          <In mono data-f="newslot" placeholder="имя слота" value={name} onInput={(e) => setName(e.currentTarget.value)} />
          <Btn disabled={!name.trim() || !first} onClick={() => run({ slot: name.trim(), order: [first!] }, `слот ${name.trim()} создан`)}>
            ＋ слот
          </Btn>
        </div>
      ) : null}
      {Object.keys(answer?.slots ?? {})
        .filter((n) => !hasSessions(n))
        .map((n) => (
          <Btn key={n} bad data-delete-slot={n} onClick={() => run({ slot: n, order: [] }, `слот ${n} удалён`)}>
            {`Удалить слот ${n}`}
          </Btn>
        ))}
      <Btn onClick={close}>Закрыть</Btn>
    </div>
  );
}

function MachineLine({ row, all, panel, setPanel, marked }: { row: MachineRowInfo; all: Merged[]; panel: Panel; setPanel(p: Panel): void; marked: string }) {
  const app = useApp();
  const state = useAccounts();
  const m = row.machine;
  const answers = app.use(() => state.answers.get());
  const sessions = app.use(() => app.roster()?.sessions ?? []);
  const login = app.use(() => state.logins()[m]);
  const label = app.use(() => machineLabel(app, m).text);
  const canAccounts = app.use(() => app.can(m, "machine.accounts") === true);
  const canLogin = app.use(() => app.can(m, "machine.login") === true);
  const [notes, say] = useOutcome();
  const answer = okOf(answers[m]);
  const word = wordOf(answers[m]);
  const slots = Object.entries(answer?.slots ?? {});
  const windowsOf = (email: string) => all.find((a) => a.email === email)?.windows ?? [];
  const isOpen = (slot: string, email: string) => panel?.kind === "entry" && panel.machine === m && panel.slot === slot && panel.account === email;
  const note = (text: string, tone: OutcomeNote["tone"] = "ok") => say("row", text, tone);

  async function send(type: string, body: Record<string, unknown>, done?: string): Promise<boolean> {
    const r = await app.request<{ from?: string | null; to?: string }>(type, { machine: m, ...body });
    if (!r.ok) {
      note(refusal(r, m), "bad");
      return false;
    }
    note(r.result?.to ? `${shortName(r.result.from ?? "—")} → ${shortName(r.result.to)}` : (done ?? ""));
    void state.answers.reload(m);
    return true;
  }

  async function act(kind: string, slotName: string, slot: SlotInfo, email: string) {
    setPanel(null);
    const move = (by: number) => {
      const order = [...slot.order];
      const i = order.indexOf(email);
      if (order[i + by] === undefined) return null;
      [order[i], order[i + by]] = [order[i + by], order[i]];
      return order;
    };
    if (kind === "login") {
      const failed = await state.beginLogin(m, email);
      if (failed) note(failed, "bad");
    } else if (kind === "next") await send("slot.swap", { slot: slotName });
    else if (kind === "now") {
      if (await send("slot.swap", { slot: slotName, account: email })) if (!slot.order.includes(email)) await send("slot.set", { slot: slotName, order: [...slot.order, email] });
    } else if (kind === "up" || kind === "down") {
      const order = move(kind === "up" ? -1 : 1);
      if (order) await send("slot.set", { slot: slotName, order });
    } else if (kind === "out") await send("slot.set", { slot: slotName, order: slot.order.filter((n) => n !== email) });
    else if (kind === "add") await send("slot.set", { slot: slotName, order: [...slot.order, email] });
    else if (kind === "remove") await send("machine.account_remove", { account: email }, `${shortName(email)} удалён с ${m}`);
  }

  const loginEntry = canLogin && row.state !== "gone" ? (
    <button
      type="button"
      className={`ac-entry add${login ? " open" : ""}`}
      data-login-start={m}
      onClick={() => {
        setPanel(null);
        say("row", "");
        if (login) state.hideLogin(m);
        else void state.beginLogin(m).then((failed) => failed && note(failed, "bad"));
      }}
    >
      ＋ войти
    </button>
  ) : null;

  const opened = panel?.kind === "entry" && panel.machine === m ? slots.find(([n]) => n === panel.slot) : undefined;
  return (
    <div className="ac-m" data-machine={m} data-state={row.state}>
      <div className="ac-mline">
        <button type="button" className="ac-mname" aria-expanded={panel?.kind === "machine" && panel.machine === m} onClick={() => setPanel(panel?.kind === "machine" && panel.machine === m ? null : { kind: "machine", machine: m })}>
          <Dot kind={row.state === "gone" ? "gone" : row.state === "fail" ? "bad" : "idle"} />
          <b>{label}</b>
          {row.state === "gone" && row.at ? <span className="ac-gone">{`ушла ${hhmm(row.at)}`}</span> : null}
        </button>
        <div className="ac-slots">
          {slots.map(([name, slot], i) => {
            const list = [...new Set([...(slot.account ? [slot.account] : []), ...slot.order, ...Object.keys(answer?.accounts ?? {})])];
            return (
              <div key={name} className="ac-slot" data-slot={`${m}:${name}`}>
                {slots.length > 1 ? <span className="ac-slotname">{name}</span> : null}
                {list.map((email) => (
                  <Entry key={email} machine={m} slot={slot} info={answer?.accounts[email]} email={email} windows={windowsOf(email)} open={isOpen(name, email)} marked={marked === email} toggle={() => setPanel(isOpen(name, email) ? null : { kind: "entry", machine: m, slot: name, account: email })} />
                ))}
                {slot.wait ? <span className="ac-wait">{`ждёт сброса ${at(slot.wait)}`}</span> : null}
                {i === slots.length - 1 ? loginEntry : null}
              </div>
            );
          })}
          {!slots.length ? <div className="ac-slot">{loginEntry}</div> : null}
          {word && canAccounts ? (
            <Note tone="bad" data-refused={`${m} · machine.accounts`}>
              {`machine.accounts: ${word}`}
            </Note>
          ) : null}
        </div>
      </div>
      {opened && panel?.kind === "entry" ? <EntryActions machine={m} slotName={opened[0]} slot={opened[1]} email={panel.account} off={answer?.accounts[panel.account]?.login !== "ok"} act={(k) => void act(k, opened[0], opened[1], panel.account)} close={() => setPanel(null)} /> : null}
      {panel?.kind === "machine" && panel.machine === m ? <MachinePanel machine={m} answer={answer} hasSessions={(slot) => sessions.some((s) => machineOf(s.callsign) === m && (s.slot as { name?: string } | undefined)?.name === slot)} run={(body, done) => void send("slot.set", body, done)} close={() => setPanel(null)} /> : null}
      {login ? <LoginPanel machine={m} note={note} /> : null}
      <Outcome className="ac-note" note={notes.row} data-note={m} />
    </div>
  );
}

export function AccountsScreen() {
  const app = useApp();
  const state = useAccounts();
  const [panel, setPanel] = useState<Panel>(null);
  const [marked, setMarked] = useState("");
  const answers = app.use(() => state.answers.get());
  const rows = app.use(() => (app.mark("machines.rows") as MachineRowInfo[] | undefined) ?? []);
  useEffect(() => {
    app.run("keeper.open");
    const close = state.mount();
    return () => {
      close();
      app.run("keeper.close");
    };
    // экран открыт — ответы свежие; app один на модуль
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);
  const all = merged(answers, nowS());
  const columns = [...new Set(all.flatMap((a) => a.windows.map((w) => w.key)))].sort(order);
  return (
    <Page>
      <div className="ac-page">
        {all.length ? (
          <div className="ac-list" style={{ "--ac-cols": Math.max(columns.length, 1) } as React.CSSProperties}>
            {all.map((a) => (
              <AccountLine key={a.email} a={a} columns={columns} marked={marked === a.email} mark={() => setMarked(marked === a.email ? "" : a.email)} panel={panel} setPanel={setPanel} />
            ))}
          </div>
        ) : null}
        <div className="ac-machines">
          {rows.map((row) => (
            <MachineLine key={row.machine} row={row} all={all} panel={panel} setPanel={setPanel} marked={marked} />
          ))}
        </div>
      </div>
    </Page>
  );
}
