// «Пропуска»: машины, устройства и программы; пригласить и отозвать.
import qrcode from "qrcode-generator";
import { useState } from "react";
import { Btn, Cmd, CopyButton, day, In, Note, Opts, Pill, Sec, useApp, useLoad, useModule } from "@switchboard/web-ui";
import { isMe, wordText, type Pass } from "./rules.ts";
import type { Invited, SettingsState } from "./state.ts";

const KINDS = [["device", "устройство"], ["program", "программа"], ["machine", "машина"]] as const;

function Qr({ url }: { url: string }) {
  const code = qrcode(0, "M");
  code.addData(url);
  code.make();
  return <div className="st-qr" data-qr={url} role="img" aria-label="QR ссылки для телефона" dangerouslySetInnerHTML={{ __html: code.createSvgTag({ scalable: true }) }} />;
}

function Link({ label, value }: { label: string; value: string }) {
  return (
    <Opts data-link={label}>
      {label ? <b className="st-lbl">{label}</b> : null}
      <Cmd className="st-link">{value}</Cmd>
      <CopyButton text={value} />
    </Opts>
  );
}

/** Выданное приглашение: устройству — ссылки на пульт и телефон, программе и машине — само приглашение. */
function InvitedBlock({ invited, done }: { invited: Invited; done(): void }) {
  const app = useApp();
  const page = (base: string | null) => (base ? `${base.replace(/\/$/, "")}/#invite=${invited.invite}` : null);
  const pult = `${location.href.split("#")[0].split("?")[0].replace(/\/$/, "")}#invite=${invited.invite}`.replace(/\/?#/, location.protocol === "file:" ? "#" : "/#");
  const phone = page(app.worker("phone"));
  const title = invited.kind === "device" ? "Ссылка для " : invited.kind === "program" ? "Приглашение для " : "Приглашение машины ";
  return (
    <Sec tone="ok" data-invited="">
      <div className="st-inv">
        <div className="st-invl">
          <span>
            {title}
            <b>
              <span className="sb-m">{invited.addr}</span>
            </b>
          </span>
          {invited.kind === "device" ? (
            <>
              <Link label="Пульт" value={pult} />
              {phone ? <Link label="Телефон" value={phone} /> : null}
            </>
          ) : (
            <Link label="" value={invited.invite} />
          )}
          <Opts>
            <Btn onClick={done}>Готово</Btn>
          </Opts>
        </div>
        {invited.kind === "device" && phone ? <Qr url={phone} /> : null}
      </div>
    </Sec>
  );
}

function InviteForm({ done, close }: { done(i: Invited): void; close(): void }) {
  const app = useApp();
  const [kind, setKind] = useState<Invited["kind"]>("device");
  const [name, setName] = useState("");
  const [who, setWho] = useState("");
  const [word, setWord] = useState("");
  async function send() {
    setWord("");
    const r = await app.request<{ kid: string; invite: string; addr: string }>("keys.invite", kind === "machine" ? { role: "host", name } : { role: "client", name, person: who });
    if (r.ok) done({ addr: r.result.addr, invite: r.result.invite, kind });
    else setWord(wordText(r.error));
  }
  return (
    <Sec data-invite="">
      <Opts>
        {KINDS.map(([k, label]) => (
          <Btn key={k} aria-pressed={kind === k ? "true" : "false"} onClick={() => setKind(k)}>
            {label}
          </Btn>
        ))}
      </Opts>
      <Opts>
        <In data-f="iname" aria-label="Имя" placeholder={kind === "machine" ? "имя машины" : "laptop"} value={name} onChange={() => {}} onInput={(e) => setName(e.currentTarget.value)} />
        {kind === "machine" ? null : <In data-f="iwho" aria-label="Почта" placeholder="почта" value={who} onChange={() => {}} onInput={(e) => setWho(e.currentTarget.value)} />}
      </Opts>
      <Opts>
        <Btn pri onClick={() => void send()}>
          Пригласить
        </Btn>
        <Btn onClick={close}>Отмена</Btn>
      </Opts>
      {word ? (
        <Note tone="bad" role="alert">
          {word}
        </Note>
      ) : null}
    </Sec>
  );
}

function PassesTable({ title, rows, revoke }: { title: string; rows: Pass[]; revoke(p: Pass): void }) {
  const app = useApp();
  const [asking, setAsking] = useState("");
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
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p.id} data-pass={p.id}>
              <td>
                <span className="sb-m">{p.addr}</span>
              </td>
              <td>{p.state === "ok" ? <Pill tone="ok">действует</Pill> : <Pill tone="wait">ждёт приёма</Pill>}</td>
              <td>
                <span className="sb-m">{p.by}</span>
              </td>
              <td>{day(p.at)}</td>
              <td>
                {isMe(app)(p) ? (
                  <Note>это устройство</Note>
                ) : asking === p.id ? (
                  <Opts>
                    <Btn
                      bad
                      onClick={() => {
                        setAsking("");
                        revoke(p);
                      }}
                    >
                      Отозвать
                    </Btn>
                    <Btn onClick={() => setAsking("")}>Отмена</Btn>
                  </Opts>
                ) : (
                  <Btn bad onClick={() => setAsking(p.id)}>
                    Отозвать…
                  </Btn>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Sec>
  );
}

export function Passes() {
  const app = useApp();
  const st = useModule<SettingsState>();
  const invited = app.use(() => st.get().invited);
  const passes = useLoad(() => app.read<{ passes: Pass[] }>("keys.list"), []);
  const [form, setForm] = useState(false);
  const [word, setWord] = useState("");
  const all = passes.data?.passes ?? [];

  async function revoke(p: Pass) {
    setWord("");
    const r = await app.request("keys.revoke", { kid: p.id });
    if (r.ok) {
      app.toast(`${p.addr} отозван — соединения закрыты`, "ok");
      passes.reload();
    } else setWord(`${p.addr}: ${wordText(r.error)}`);
  }

  return (
    <>
      {form ? null : (
        <Opts>
          <Btn pri onClick={() => setForm(true)}>
            Пригласить
          </Btn>
        </Opts>
      )}
      {form ? (
        <InviteForm
          close={() => setForm(false)}
          done={(i) => {
            st.setInvited(i);
            setForm(false);
            passes.reload();
          }}
        />
      ) : null}
      {invited ? <InvitedBlock invited={invited} done={() => st.setInvited(null)} /> : null}
      {passes.error ? <Note tone="bad">{`keys.list: ${passes.error}`}</Note> : null}
      {word ? (
        <Note tone="bad" role="alert">
          {word}
        </Note>
      ) : null}
      {passes.data ? (
        <>
          <PassesTable title="Машины" rows={all.filter((p) => p.role === "host")} revoke={(p) => void revoke(p)} />
          <PassesTable title="Устройства и программы" rows={all.filter((p) => p.role !== "host")} revoke={(p) => void revoke(p)} />
        </>
      ) : null}
    </>
  );
}
