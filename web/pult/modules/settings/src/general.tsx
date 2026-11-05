// «GitHub и устройство»: приложение GitHub флота и это устройство.
import { useState } from "react";
import { Btn, In, LinkBtn, Note, Opts, PageHead, Pill, plural, Row, Sec, useApp, useLoad, useModule } from "@switchboard/web-ui";
import { isMe, wordText, type Pass } from "./rules.ts";
import type { SettingsState } from "./state.ts";

type AppAnswer = { app: { slug: string } | null; repos?: string[]; install?: string; form?: { action: string; manifest: unknown } };
const PUSH: Record<string, string> = { on: "включены", ask: "выключены", error: "не включились", working: "включаю…", denied: "запрещены в браузере", off: "браузер не умеет" };

/** Форма создания приложения уходит на GitHub обычной отправкой: окно после запроса браузер заблокировал бы. */
function sendForm(form: { action: string; manifest: unknown }) {
  const el = document.createElement("form");
  el.method = "post";
  el.action = form.action;
  const field = document.createElement("input");
  field.type = "hidden";
  field.name = "manifest";
  field.value = JSON.stringify(form.manifest);
  el.append(field);
  document.body.append(el);
  el.submit();
  el.remove();
}

export function GitHub() {
  const app = useApp();
  const st = useModule<SettingsState>();
  const answer = useLoad(() => app.read<AppAnswer>("github.app"), []);
  const code = app.use(() => st.get().code);
  const [q, setQ] = useState("");
  const [org, setOrg] = useState("");
  const [word, setWord] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  async function create() {
    setWord("");
    const r = await app.request<AppAnswer>("github.app", org ? { org } : {});
    if (!r.ok) return setWord(wordText(r.error));
    if (r.result.form) sendForm(r.result.form);
    else answer.reload();
  }
  async function save() {
    if (saving) return;
    setWord("");
    setSaving(true);
    const r = await app.request("github.setup", { code });
    setSaving(false);
    if (!r.ok) return setWord(wordText(r.error));
    st.setCode("");
    setSaved(true);
    history.replaceState(null, "", `${location.pathname}${location.hash}`);
    answer.reload();
  }

  const a = answer.data;
  const repos = (a?.repos ?? []).filter((x) => x.toLowerCase().includes(q.trim().toLowerCase()));
  const count = a?.repos?.length ?? 0;
  return (
    <Sec data-github="">
      <b>Приложение GitHub флота</b>
      {answer.error ? <Note tone="bad">{`github.app: ${answer.error}`}</Note> : null}
      {code ? (
        <>
          <span>GitHub вернул код нового приложения.</span>
          <Opts>
            <Btn pri onClick={() => void save()}>
              Сохранить приложение
            </Btn>
          </Opts>
          {saving ? <Note role="status">Сохраняю приложение…</Note> : null}
        </>
      ) : a?.app ? (
        <>
          <PageHead>
            <span className="sb-m st-grow">
              <b>{a.app.slug}</b>
            </span>
            <Pill tone="ok">{`${count} ${plural(count, "репозиторий", "репозитория", "репозиториев")}`}</Pill>
            {a.install ? (
              <LinkBtn href={a.install} target="_blank" rel="noopener">
                Доступ на GitHub ↗
              </LinkBtn>
            ) : null}
          </PageHead>
          {count ? (
            <>
              <Opts className="st-nowrap">
                <In className="st-grow" data-f="gq" aria-label="Найти репозиторий" placeholder="Найти репозиторий" value={q} onChange={() => {}} onInput={(e) => setQ(e.currentTarget.value)} />
              </Opts>
              <div className="st-repos">
                {repos.map((r) => (
                  <div key={r} className="st-repo" data-repo={r}>
                    <span className="sb-m st-grow">{r}</span>
                  </div>
                ))}
                {repos.length ? null : <Note className="st-repo">Таких нет</Note>}
              </div>
            </>
          ) : null}
        </>
      ) : a && !code ? (
        <Opts>
          <In mono data-f="org" aria-label="Организация" placeholder="организация" value={org} onChange={() => {}} onInput={(e) => setOrg(e.currentTarget.value)} />
          <Btn pri onClick={() => void create()}>
            Создать приложение GitHub
          </Btn>
        </Opts>
      ) : null}
      {saved ? (
        <Note tone="ok" role="status">
          Приложение сохранено — установите его на репозитории.
        </Note>
      ) : null}
      {word ? (
        <Note tone="bad" role="alert">
          {word}
        </Note>
      ) : null}
    </Sec>
  );
}

export function Device() {
  const app = useApp();
  const address = app.use(() => app.address());
  const push = app.use(() => app.mark("alerts.state") as string | undefined);
  const passes = useLoad(() => app.read<{ passes: Pass[] }>("keys.list"), []);
  const mine = passes.data?.passes.find(isMe(app));
  return (
    <Sec data-device="">
      <b>Это устройство</b>
      <Row label="адрес">
        <span className="sb-m">{address ?? mine?.addr ?? "—"}</span>
      </Row>
      <Row label="пропуск">
        <span>
          {mine ? "действует" : "—"}
          {app.wide ? (
            <Btn className="st-ml8" onClick={() => app.open("settings", { tab: "passes" })}>
              Пропуска
            </Btn>
          ) : null}
        </span>
      </Row>
      <Row label="уведомления">
        <span data-push={push ?? ""}>{push ? (PUSH[push] ?? push) : "—"}</span>
      </Row>
    </Sec>
  );
}
