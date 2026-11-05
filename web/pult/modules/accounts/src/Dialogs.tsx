// Окна действий над аккаунтом и слотом. Шаги удаления выполняет машина: один запрос.
import { useState } from "react";
import { Btn, Check, H4, Note, okOf, Opts, OptsLabel, Outcome, plainSession, Row, Sec, Sel, useApp } from "@switchboard/web-ui";
import type { Shared } from "./AccountsColumn.tsx";
import { refusal, useAccounts } from "./state.ts";

const NEXT = "следующего по порядку — выберет Host";

type Props = Pick<Shared, "answers" | "say"> & { machine: string; close(): void };

export function RemoveDialog({ answers, machine, name, say, close }: Props & { name: string }) {
  const app = useApp();
  const state = useAccounts();
  const [next, setNext] = useState("");
  const slots = Object.entries(okOf(answers[machine])?.slots ?? {}).filter(([, s]) => s.account === name);
  const names = slots.flatMap(([, s]) => s.sessions.map((c) => plainSession(c).text));
  const many = slots.length > 1;
  const list = slots.map(([n]) => n).join(", ");
  const others = [...new Set(slots.flatMap(([, s]) => s.order))].filter((n) => n !== name);
  const key = `rm:${machine}:${name}`;

  async function remove() {
    say(key, "Удаляю…");
    const r = await app.request("machine.account_remove", { machine, account: name, ...(next ? { next } : {}) });
    if (!r.ok) return say(key, refusal(r, machine), "bad");
    close();
    say(key, `${name} удалён с ${machine}`, "ok");
    void state.answers.reload(machine);
  }

  return (
    <Sec dlg data-dlg="rm">
      <H4>{`Удалить ${name} с ${machine}`}</H4>
      {slots.length ? (
        <>
          <Note>{`${name} сейчас ${many ? "в слотах" : "в слоте"} ${list}`}</Note>
          <Note>{`Сначала ${many ? "каждый слот" : "слот"} сменит аккаунт — ${names.length ? names.join(", ") : "сессии слота"} продолжат на новом, — потом ${name} уйдёт из порядка слотов и удалится.`}</Note>
          <Row label={many ? "Кого положить в слоты" : `Кого положить в слот ${list}`}>
            <Sel data-f="next" value={next} onChange={(e) => setNext(e.currentTarget.value)}>
              <option value="">{NEXT}</option>
              {others.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </Sel>
          </Row>
        </>
      ) : null}
      <Note>{`Стирается только папка ${name} на ${machine}. Вход машины и другие аккаунты не трогаются.`}</Note>
      <Opts>
        <Btn bad onClick={() => void remove()}>
          {slots.length ? "Сменить и удалить" : "Удалить"}
        </Btn>
        <Btn onClick={close}>Отмена</Btn>
      </Opts>
    </Sec>
  );
}

export function SessionsDialog({ answers, machine, slot, notes, say, close }: Props & Pick<Shared, "notes"> & { slot: string }) {
  const app = useApp();
  const state = useAccounts();
  const [swapTo, setSwapTo] = useState("");
  const [target, setTarget] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string[]>([]);
  const all = okOf(answers[machine])?.slots ?? {};
  const info = all[slot];
  if (!info) return null;
  const others = Object.keys(all).filter((n) => n !== slot);
  const to = target ?? others[0] ?? "";
  const swapKey = `swap:${machine}:${slot}`;
  const moveKey = `move:${machine}:${slot}`;

  async function move() {
    const lines: string[] = [];
    for (const callsign of chosen) {
      const r = await app.request<{ restart: boolean }>("session.slot", { callsign, slot: to || null });
      lines.push(`${callsign}: ${r.ok ? (r.result.restart ? "перейдёт между ходами" : "перешла") : refusal(r, machine)}`);
    }
    say(moveKey, lines.join(" · "));
    void state.answers.reload(machine);
  }

  return (
    <Sec dlg data-dlg="sess">
      <H4>{`Сессии слота ${slot} на ${machine} · сейчас ${info.account ?? "никого"}`}</H4>
      <Row label="Сменить аккаунт всему слоту">
        <Opts>
          <SwapChoice field="swap" order={info.order} account={info.account} value={swapTo} on={setSwapTo} />
          <Btn onClick={() => void swapSlot(app, state, machine, slot, info.account, swapTo, say)}>Сменить сейчас</Btn>
        </Opts>
      </Row>
      <Outcome note={notes[swapKey]} data-note={swapKey} />
      <H4>Перевести выбранные в другой слот</H4>
      {info.sessions.map((c) => (
        <OptsLabel key={c}>
          <Check checked={chosen.includes(c)} onChange={(e) => setChosen(e.currentTarget.checked ? [...chosen, c] : chosen.filter((x) => x !== c))} />
          {c}
        </OptsLabel>
      ))}
      <Opts>
        <Sel data-f="target" value={to} onChange={(e) => setTarget(e.currentTarget.value)}>
          {others.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
          <option value="">без слота — вход машины</option>
        </Sel>
        <Btn disabled={!chosen.length} onClick={() => void move()}>
          Перевести
        </Btn>
      </Opts>
      <Outcome note={notes[moveKey]} data-note={moveKey} />
      <Opts>
        <Btn onClick={close}>Закрыть</Btn>
      </Opts>
    </Sec>
  );
}

/** Кого положить в слот: следующего выберет Host или из порядка. */
export function SwapChoice({ field, order, account, value, on }: { field: string; order: string[]; account: string | null; value: string; on(v: string): void }) {
  return (
    <Sel data-f={field} value={value} onChange={(e) => on(e.currentTarget.value)}>
      <option value="">{NEXT}</option>
      {order
        .filter((n) => n !== account)
        .map((n) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
    </Sel>
  );
}

/** «Сменить сейчас»: итог известен из ответа, перечитывать незачем. */
export async function swapSlot(app: ReturnType<typeof useApp>, state: ReturnType<typeof useAccounts>, machine: string, slot: string, from: string | null, account: string, say: Shared["say"]) {
  const key = `swap:${machine}:${slot}`;
  say(key, "Меняю…");
  const r = await app.request<{ from: string | null; to: string }>("slot.swap", { machine, slot, ...(account ? { account } : {}) });
  if (!r.ok) return say(key, refusal(r, machine), "bad");
  say(key, `${r.result.from ?? from} → ${r.result.to}`, "ok");
  const was = okOf(state.answers.get()[machine]);
  if (was) state.answers.put(machine, { ...was, slots: { ...was.slots, [slot]: { ...was.slots[slot], account: r.result.to } } });
}
