// Вкладка «Пропуска»: машины и устройства, приглашение и отзыв. Это устройство не отзывается.
import { useState } from "react";
import { Btn, M, Note, Opts, Pill, Sec, useApp, okOf } from "@switchboard/web-ui";
import { useSettings } from "./store.ts";
import { Invited, InviteForm } from "./Invite.tsx";
import { NoteOf } from "./parts.tsx";
import type { Pass } from "./store.ts";

const WORD = { ok: ["действует", "ok"], wait: ["ждёт приёма", "wait"] } as const;

function PassRow({ p, mine }: { p: Pass; mine: boolean }) {
  const app = useApp();
  const settings = useSettings();
  const asking = app.use(() => settings.get().confirm === p.id);
  return (
    <tr data-pass={p.id}>
      <td>
        <M>{p.addr}</M>
      </td>
      <td>
        <Pill tone={WORD[p.state][1]}>{WORD[p.state][0]}</Pill>
      </td>
      <td>
        <M>{p.by}</M>
      </td>
      <td>{new Date(p.at).toLocaleDateString("ru-RU", { day: "numeric", month: "short" })}</td>
      <td>
        {mine ? (
          <Note>это устройство</Note>
        ) : asking ? (
          <Opts>
            <Btn bad onClick={() => void settings.revoke(p)}>
              Отозвать
            </Btn>
            <Btn onClick={() => settings.askRevoke(null)}>Отмена</Btn>
          </Opts>
        ) : (
          <Btn bad onClick={() => settings.askRevoke(p.id)}>
            Отозвать…
          </Btn>
        )}
      </td>
    </tr>
  );
}

function PassTable({ title, rows, me }: { title: string; rows: Pass[]; me: Pass | undefined }) {
  if (!rows.length) return null;
  return (
    <Sec data-passes={title}>
      <b>{title}</b>
      <table className="st-tbl">
        <colgroup>
          <col className="st-w28" />
          <col className="st-w16" />
          <col className="st-w22" />
          <col className="st-w14" />
          <col />
        </colgroup>
        <thead>
          <tr>
            <th>адрес</th>
            <th>состояние</th>
            <th>кто пригласил</th>
            <th>когда</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <PassRow key={p.id} p={p} mine={p.id === me?.id} />
          ))}
        </tbody>
      </table>
    </Sec>
  );
}

export function Passes() {
  const app = useApp();
  const settings = useSettings();
  const passes = app.use(() => settings.get().passes);
  const [inviting, setInviting] = useState(false);
  const invited = app.use(() => settings.get().invited);
  const ps = okOf(passes) ?? [];
  const me = ps.find((p) => p.role === "client" && p.name === app.name && p.state === "ok");
  return (
    <>
      <Opts>
        {inviting || invited ? null : (
          <Btn pri onClick={() => setInviting(true)}>
            Пригласить
          </Btn>
        )}
      </Opts>
      {inviting ? <InviteForm close={() => setInviting(false)} /> : invited ? <Invited x={invited} /> : null}
      {passes && "error" in passes ? (
        <Note tone="bad" role="alert">{`keys.list: ${passes.error}`}</Note>
      ) : passes ? null : (
        <Note>…</Note>
      )}
      <PassTable title="Машины" rows={ps.filter((p) => p.role === "host")} me={me} />
      <PassTable title="Устройства и программы" rows={ps.filter((p) => p.role === "client")} me={me} />
      <NoteOf k="passes" />
    </>
  );
}
