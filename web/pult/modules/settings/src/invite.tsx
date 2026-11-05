// Приглашение: форма и итог. Устройству — ссылки на пульт и телефон (QR — на телефон), программе и машине — приглашение строкой.
import { useMemo, useState } from "react";
import { Btn, Cmd, CopyButton, In, M, Opts, Outcome, Sec, useApp, useOutcome } from "@switchboard/web-ui";
import qrcode from "qrcode-generator";
import { useSettings, type Invited as InvitedInfo, type Inviting, type Kind } from "./state.ts";

const KINDS: Array<[Kind, string]> = [["device", "устройство"], ["program", "программа"], ["machine", "машина"]];
const INVITE_FOR: Record<Kind, string> = { device: "Ссылка для ", program: "Приглашение для ", machine: "Приглашение машины " };

/** QR ссылки: модули qrcode-generator рисунком на белом поле. */
function Qr({ text }: { text: string }) {
  const { n, d } = useMemo(() => {
    const q = qrcode(0, "M");
    q.addData(text);
    q.make();
    const count = q.getModuleCount();
    let path = "";
    for (let r = 0; r < count; r++) for (let c = 0; c < count; c++) if (q.isDark(r, c)) path += `M${c} ${r}h1v1h-1z`;
    return { n: count, d: path };
  }, [text]);
  return (
    <div className="st-qr" role="img" aria-label="QR ссылки для телефона" data-qr={text}>
      <svg viewBox={`0 0 ${n} ${n}`} shapeRendering="crispEdges">
        <path d={d} fill="#000" />
      </svg>
    </div>
  );
}

/** Форма живёт, пока открыта; выдано или отмена — close. */
export function InviteForm({ close, invited }: { close(): void; invited(): void }) {
  const settings = useSettings();
  const [f, setF] = useState<Inviting>({ kind: "device", name: "", person: "" });
  const [notes, say] = useOutcome();
  const change = (patch: Partial<Inviting>) => setF((x) => ({ ...x, ...patch }));
  return (
    <Sec data-invite="">
      <Opts>
        {KINDS.map(([k, label]) => (
          <Btn key={k} aria-pressed={f.kind === k ? "true" : "false"} onClick={() => change({ kind: k })}>
            {label}
          </Btn>
        ))}
      </Opts>
      <Opts>
        <In data-f="iname" placeholder={f.kind === "machine" ? "имя машины" : "laptop"} aria-label="Имя" value={f.name} onInput={(e) => change({ name: e.currentTarget.value })} />
        {f.kind === "machine" ? null : <In data-f="iwho" placeholder="почта" aria-label="Почта" value={f.person} onInput={(e) => change({ person: e.currentTarget.value })} />}
      </Opts>
      <Opts>
        <Btn
          pri
          onClick={() =>
            void settings.invite(f).then((r) => {
              if (!r.ok) return say("invite", r.error, "bad");
              close();
              invited();
            })
          }
        >
          Пригласить
        </Btn>
        <Btn onClick={close}>Отмена</Btn>
      </Opts>
      <Outcome note={notes.invite} />
    </Sec>
  );
}

export function Invited({ x }: { x: InvitedInfo }) {
  const app = useApp();
  const settings = useSettings();
  // устройству — ссылка на пульт и на телефон (адрес страницы телефона — из сборки); копирует человек нужную
  const phoneUrl = app.worker("phone");
  const toPhone = x.kind === "device" && phoneUrl ? new URL(`#invite=${x.invite}`, phoneUrl).href : undefined;
  const rows: Array<[string | null, string]> = x.kind === "device" ? [["Пульт", `${location.origin}${location.pathname}#invite=${x.invite}`], ...(toPhone ? [["Телефон", toPhone] as [string, string]] : [])] : [[null, x.invite]];
  return (
    <Sec tone="ok" data-invited="">
      <div className="st-inv">
        <div className="st-invl">
          <span>
            {INVITE_FOR[x.kind]}
            <b>
              <M>{x.addr}</M>
            </b>
          </span>
          {rows.map(([label, text]) => (
            <Opts key={text} data-link={label ?? ""}>
              {label ? <b className="st-lbl">{label}</b> : null}
              <Cmd className="st-link">{text}</Cmd>
              <CopyButton text={text} label="Копировать" />
            </Opts>
          ))}
          <Opts>
            <Btn onClick={settings.closeInvited}>Готово</Btn>
          </Opts>
        </div>
        {/* QR — ссылки на телефон: её сканируют телефоном; колонка справа, в узком окне — под ссылками */}
        {toPhone ? <Qr text={toPhone} /> : null}
      </div>
    </Sec>
  );
}
