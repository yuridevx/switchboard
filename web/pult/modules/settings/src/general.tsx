// «GitHub и устройство»: приложение GitHub флота, один список репозиториев и это устройство.
import { useState } from "react";
import { Btn, In, LinkBtn, M, Note, PageHead, Row, Sec, useApp, useLoad } from "@switchboard/web-ui";
import { ProfileRepos } from "./repos.tsx";
import { isMine, wordFor } from "./rules.ts";

type GithubAnswer = { app: { slug: string } | null; repos?: string[]; install?: string; form?: { action: string; manifest: unknown } };
type Pass = { kid: string; addr: string; owner: string | null; wait: boolean };

const PUSH: Record<string, string> = { on: "включены", ask: "выключены", error: "не включились", working: "включаю…", denied: "запрещены в браузере", off: "браузер не умеет" };

/** Адрес пульта: туда GitHub вернёт браузер с кодом. */
const redirect = () => location.origin + location.pathname;

/** Код нового приложения, который GitHub вернул в адресе. */
export const githubCode = () => new URLSearchParams(location.search).get("code");

/** Форму создания приложения принимает только сам GitHub: страница уходит к нему. */
function submit(form: NonNullable<GithubAnswer["form"]>) {
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
}

function Github() {
  const app = useApp();
  const gh = useLoad(() => app.read<GithubAnswer>("github.app", { redirect: redirect() }), []);
  const [org, setOrg] = useState("");
  const [word, setWord] = useState("");
  const [code, setCode] = useState(githubCode());
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  async function create() {
    setWord("");
    const r = await app.request<GithubAnswer>("github.app", { redirect: redirect(), ...(org ? { org } : {}) });
    if (!r.ok) return setWord(wordFor(r.error));
    if (r.result.form) submit(r.result.form);
    else gh.reload();
  }
  async function save() {
    if (saving) return;
    setWord("");
    setSaving(true);
    const r = await app.request("github.setup", { code });
    setSaving(false);
    if (!r.ok) return setWord(wordFor(r.error));
    history.replaceState(null, "", `${location.pathname}${location.hash}`);
    setCode(null);
    setSaved(true);
    gh.reload();
  }
  return (
    <>
    <Sec data-github="">
      <b>Приложение GitHub флота</b>
      {gh.error && <Note tone="bad">{`github.app: ${gh.error}`}</Note>}
      {code && <span>GitHub вернул код нового приложения.</span>}
      {code && <Btn pri onClick={() => void save()}>Сохранить приложение</Btn>}
      {saving && <Note role="status">Сохраняю приложение…</Note>}
      {!code && gh.data?.app && (
        <>
          <PageHead>
            <M className="st-grow">
              <b>{gh.data.app.slug}</b>
            </M>
            {gh.data.install && (
              <LinkBtn href={gh.data.install} target="_blank" rel="noopener">
                Доступ на GitHub ↗
              </LinkBtn>
            )}
          </PageHead>
        </>
      )}
      {gh.data && !gh.data.app && !code && (
        <>
          <In mono data-f="org" placeholder="организация" aria-label="Организация" value={org} onInput={(e) => setOrg(e.currentTarget.value)} />
          <Btn pri onClick={() => void create()}>
            Создать приложение GitHub
          </Btn>
        </>
      )}
      {saved && (
        <Note tone="ok" role="status">
          Приложение сохранено — установите его на репозитории.
        </Note>
      )}
      {word && (
        <Note tone="bad" role="alert">
          {word}
        </Note>
      )}
    </Sec>
    <ProfileRepos github={gh.data?.repos ?? []} ready={!gh.loading || !!gh.data} />
    </>
  );
}

function Device() {
  const app = useApp();
  const passes = useLoad(() => app.read<{ passes: Pass[] }>("keys.list"), []);
  const push = app.use(() => app.mark("alerts.state") as string | undefined);
  const address = app.use(() => app.address());
  const pass = app.use(() => passes.data?.passes.find((p) => isMine(app, p)));
  return (
    <Sec data-device="">
      <b>Это устройство</b>
      <Row label="адрес">
        <M>{address ?? pass?.addr ?? "—"}</M>
      </Row>
      <Row label="пропуск">
        <span>
          {pass ? "действует" : "—"}
          {app.wide && (
            <Btn className="st-ml8" onClick={() => app.open("people")}>
              Люди
            </Btn>
          )}
        </span>
      </Row>
      <Row label="уведомления">
        <span data-push={push ?? ""}>{push ? (PUSH[push] ?? push) : "—"}</span>
      </Row>
      {passes.error && <Note tone="bad">{`keys.list: ${passes.error}`}</Note>}
    </Sec>
  );
}

export function GeneralTab() {
  const app = useApp();
  return (
    <>
      {app.wide && <Github />}
      <Device />
    </>
  );
}
