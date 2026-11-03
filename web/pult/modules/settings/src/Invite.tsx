// Приглашение: форма и итог. Устройству — ссылки на пульт и телефон (QR — на телефон), программе и машине — приглашение строкой.
import { useMemo } from "react";
import { Btn, Cmd, M, Opts, Sec, useApp } from "@switchboard/web-ui";
import qrcode from "qrcode-generator";
import { useSettings } from "./context.ts";
import { NoteOf, StoredIn } from "./parts.tsx";
import type { Invited as InvitedInfo, Inviting, Kind } from "./store.ts";

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

function KindButton({ k, label, cur }: { k: Kind; label: string; cur: Kind }) {
  const settings = useSettings();
  return (
    <Btn aria-pressed={cur === k ? "true" : "false"} onClick={() => settings.editInvite({ kind: k })}>
      {label}
    </Btn>
  );
}

export function InviteForm({ f }: { f: Inviting }) {
  const settings = useSettings();
  return (
    <Sec data-invite="">
      <Opts>
        <KindButton k="device" label="устройство" cur={f.kind} />
        <KindButton k="program" label="программа" cur={f.kind} />
        <KindButton k="machine" label="машина" cur={f.kind} />
      </Opts>
      <Opts>
        <StoredIn data-f="iname" placeholder={f.kind === "machine" ? "имя машины" : "laptop"} aria-label="Имя" initial={f.name} onValue={(name) => settings.editInvite({ name })} />
        {f.kind === "machine" ? null : <StoredIn data-f="iwho" placeholder="почта" aria-label="Почта" initial={f.person} onValue={(person) => settings.editInvite({ person })} />}
      </Opts>
      <Opts>
        <Btn pri onClick={() => void settings.invite()}>
          Пригласить
        </Btn>
        <Btn onClick={settings.cancelInvite}>Отмена</Btn>
      </Opts>
      <NoteOf k="invite" />
    </Sec>
  );
}

export function Invited({ x }: { x: InvitedInfo }) {
  const app = useApp();
  const settings = useSettings();
  // устройству — ссылка на пульт и на телефон (адрес страницы телефона — из сборки); копирует человек нужную
  const phone = app.worker("phone");
  const rows: Array<[string | null, string]> =
    x.kind === "device"
      ? [["Пульт", `${location.origin}${location.pathname}#invite=${x.invite}`], ...(phone ? [["Телефон", new URL(`#invite=${x.invite}`, phone).href] as [string, string]] : [])]
      : [[null, x.invite]];
  // QR — ссылки на телефон: её сканируют телефоном; колонка справа, в узком окне — под ссылками
  const toPhone = rows.find(([l]) => l === "Телефон")?.[1];
  return (
    <Sec tone="ok" data-invited="">
      <div className="st-inv">
        <div className="st-invl">
          <span>
            {x.kind === "device" ? "Ссылка для " : x.kind === "program" ? "Приглашение для " : "Приглашение машины "}
            <b>
              <M>{x.addr}</M>
            </b>
          </span>
          {rows.map(([l, text]) => (
            <Opts key={text} data-link={l ?? ""}>
              {l ? <b className="st-lbl">{l}</b> : null}
              <Cmd className="st-link">{text}</Cmd>
              <Btn pri onClick={() => settings.copy(text)}>
                Копировать
              </Btn>
            </Opts>
          ))}
          <Opts>
            <Btn onClick={settings.closeInvited}>Готово</Btn>
          </Opts>
        </div>
        {toPhone ? <Qr text={toPhone} /> : null}
      </div>
    </Sec>
  );
}
