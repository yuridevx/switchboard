// «GitHub и устройство»: приложение GitHub флота и это устройство.
import { useState } from "react";
import { Btn, In, LinkBtn, Note, plural, Row, Sec, TextBtn, useApp, useLoad } from "@switchboard/web-ui";
import { wordFor } from "./rules.ts";

type GithubAnswer = { app: { slug: string } | null; repos?: string[]; install?: string; form?: { action: string; manifest: unknown } };
type Pass = { role: string; name: string; addr: string; state: string };

const PUSH: Record<string, string> = { on: "включены", ask: "выключены", error: "не включились", working: "включаю…", denied: "запрещены в браузере", off: "браузер не умеет" };

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

function Repos({ repos }: { repos: string[] }) {
  const [q, setQ] = useState("");
  const list = repos.filter((r) => r.toLowerCase().includes(q.toLowerCase()));
  return (
    <>
      <In data-f="gq" placeholder="Найти репозиторий" aria-label="Найти репозиторий" value={q} onInput={(e) => setQ(e.currentTarget.value)} />
      <div className="st-repos">
        {list.map((r) => (
          <div key={r} className="st-repo" data-repo={r}>
            {r}
          </div>
        ))}
        {!list.length && <div className="st-repo">Таких нет</div>}
      </div>
    </>
  );
}

function Github() {
  const app = useApp();
  const gh = useLoad(() => app.read<GithubAnswer>("github.app"), []);
  const [org, setOrg] = useState("");
  const [word, setWord] = useState("");
  const [code, setCode] = useState(githubCode());
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  async function create() {
    setWord("");
    const r = await app.request<GithubAnswer>("github.app", org ? { org } : {});
    if (!r.ok) return setWord(wordFor(r.error));
    if (r.result.form) submit(r.result.form);
  }
  async function save() {
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
  const repos = gh.data?.repos ?? [];
  return (
    <Sec data-github="1">
      <b>Приложение GitHub флота</b>
      {gh.error && <Note tone="bad">{`github.app: ${gh.error}`}</Note>}
      {code && <Note>GitHub вернул код нового приложения.</Note>}
      {code && <Btn pri disabled={saving} onClick={() => void save()}>Сохранить приложение</Btn>}
      {saving && <Note>Сохраняю приложение…</Note>}
      {saved && <Note tone="ok">Приложение сохранено — установите его на репозитории.</Note>}
      {gh.data?.app && (
        <>
          <Note>{`${gh.data.app.slug} · ${repos.length} ${plural(repos.length, "репозиторий", "репозитория", "репозиториев")}`}</Note>
          {gh.data.install && (
            <LinkBtn href={gh.data.install} target="_blank" rel="noreferrer">
              Доступ на GitHub ↗
            </LinkBtn>
          )}
          <Repos repos={repos} />
        </>
      )}
      {gh.data && !gh.data.app && !code && (
        <>
          <In data-f="org" placeholder="организация" aria-label="Организация" value={org} onInput={(e) => setOrg(e.currentTarget.value)} />
          <Btn pri onClick={() => void create()}>
            Создать приложение GitHub
          </Btn>
        </>
      )}
      {word && <Note tone="bad">{word}</Note>}
    </Sec>
  );
}

function Device() {
  const app = useApp();
  const passes = useLoad(() => app.read<{ passes: Pass[] }>("keys.list"), []);
  const push = app.use(() => app.mark("alerts.state") as string | undefined);
  const pass = passes.data?.passes.find((p) => p.role === "client" && p.name === app.name);
  return (
    <Sec data-device="1">
      <b>Это устройство</b>
      <Row label="адрес">{pass?.addr ?? "—"}</Row>
      <Row label="пропуск">
        <span>
          {pass ? (pass.state === "ok" ? "действует" : pass.state) : "—"}
          {app.wide && (
            <>
              {" "}
              <TextBtn onClick={() => app.open("settings", { tab: "passes" })}>Пропуска</TextBtn>
            </>
          )}
        </span>
      </Row>
      <Row label="уведомления">
        <span data-push="1">{(push && PUSH[push]) ?? "—"}</span>
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
