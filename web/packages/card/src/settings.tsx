// Настройки участников карточки: та же таблица, что в форме новой сессии; выбор сразу уходит в сессию.
import { useState } from "react";
import { machineOf } from "@switchboard/protocol";
import type { SessionRecord } from "@switchboard/relay";
import { Confirm, Note, Outcome, profileIdsOf, profileNameOf, sessionOf, slotOf, useApp, useLoad, useMachineLoad, useOutcome, wingOf, type AccountsAnswer, type FleetKeysAnswer, type ProfilesAnswer } from "@switchboard/web-ui";
import { PartyTable, type PartySide } from "@switchboard/web-party";

type Load<T> = { data?: T; error: string };

export const Refused = ({ what, text }: { what: string; text: string }) => (
  <Note tone="bad" data-refused={what}>
    {text}
  </Note>
);

export function PairSet({ callsign, accounts }: { callsign: string; accounts: Load<AccountsAnswer> }) {
  const app = useApp();
  const machine = machineOf(callsign)!;
  const session = app.use(() => sessionOf(app, callsign));
  const wing = app.use(() => wingOf(app.roster()?.sessions ?? [], callsign));
  const profiles = useMachineLoad<ProfilesAnswer>(machine, "machine.profiles");
  const fleet = useLoad<FleetKeysAnswer>(() => app.read<FleetKeysAnswer>("fleetkeys.list", {}), []);
  const [leaving, setLeaving] = useState(false);
  const [notes, say] = useOutcome();
  async function ask(cs: string, name: string, body: Record<string, unknown>) {
    say("pair", "…");
    const r = await app.request<{ restart?: boolean }>(name, { callsign: cs, ...body });
    if (r.ok) say("pair", r.result?.restart ? "после хода" : "", "ok");
    else say("pair", `Не вышло: ${r.error}`, "bad");
  }
  const sideOf = (s: SessionRecord | undefined, cs: string | undefined): PartySide => ({
    value: { list: profileIdsOf(s), model: String(s?.model ?? ""), effort: String(s?.effort ?? ""), slot: slotOf(s)?.name ?? "" },
    set({ list, model, effort, slot }) {
      if (!cs) return;
      if (list) void ask(cs, "session.profile", { profile: list });
      if (model) void ask(cs, "session.update", { model });
      if (effort) void ask(cs, "session.update", { effort });
      if (slot && slot !== slotOf(s)?.name) void ask(cs, "session.slot", { slot });
    },
  });
  /** Пара включается новой сессией ведомого; снимается — удалением ведомого, с вопросом на месте. */
  async function open() {
    say("pair", "…");
    const list = profileIdsOf(session);
    const slot = slotOf(session)?.name;
    const r = await app.request("session.open", { machine, wing_of: callsign, ...(list.length ? { profile: list } : {}), ...(session?.model ? { model: session.model } : {}), ...(session?.effort ? { effort: session.effort } : {}), ...(slot ? { slot } : {}) });
    say("pair", r.ok ? "" : `Не вышло: ${r.error}`, r.ok ? "ok" : "bad");
  }
  const toggle = () => (wing ? setLeaving(true) : void open());
  return (
    <div className="cw-fs" data-sec="pair">
      <PartyTable lead={sideOf(session, callsign)} wing={sideOf(wing, wing?.callsign)} paired={!!wing} togglePair={toggle} data={{ machine, ready: true, profiles: profiles.data?.profiles, slots: accounts.data?.slots, keys: fleet.data?.keys ?? {} }}>
        {profiles.error && !profiles.data ? <Refused what="profile" text={[profileNameOf(session), profiles.error].filter(Boolean).join(" · ")} /> : null}
        {accounts.error && !accounts.data ? <Refused what="slot" text={[slotOf(session)?.name, accounts.error].filter(Boolean).join(" · ")} /> : null}
      </PartyTable>
      {leaving && wing ? (
        <Confirm
          text={`Убрать пару ${wing.callsign}?`}
          act="Убрать"
          run={() => {
            setLeaving(false);
            void ask(wing.callsign, "session.remove", {});
          }}
          cancel={() => setLeaving(false)}
        />
      ) : null}
      <Outcome className="cw-note" note={notes.pair} />
    </div>
  );
}
