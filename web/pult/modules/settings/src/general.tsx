// Вкладка «GitHub и устройство»: приложение GitHub флота и его репозитории; адрес, пропуск и уведомления этого устройства.
import { useEffect, useRef, useState } from "react";
import type {} from "@switchboard/web-alerts";
import { Btn, In, LinkBtn, M, Note, Opts, Outcome, PageHead, Pill, plural, Row, Sec, useApp, useOutcome } from "@switchboard/web-ui";
import { thisDevice, useGithub, usePasses } from "./load.ts";
import { useSettings, type Form, type Gh } from "./state.ts";

/** Форма manifest уходит в браузере на github.com; GitHub вернёт страницу с ?code=. */
function PostForm({ form }: { form: Form }) {
  const el = useRef<HTMLFormElement>(null);
  useEffect(() => {
    el.current?.submit();
  }, [form]);
  return (
    <form ref={el} method="post" action={form.action} hidden>
      <input type="hidden" name="manifest" value={JSON.stringify(form.manifest)} />
    </form>
  );
}

function GhCreate({ base, refused }: { base: Form | undefined; refused(text: string): void }) {
  const settings = useSettings();
  const [org, setOrg] = useState("");
  const [form, setForm] = useState<Form | undefined>();
  const create = () => {
    const name = org.trim();
    if (!name) return setForm(base);
    void settings.create(name).then((r) => (r.ok ? setForm(r.result) : refused(r.error)));
  };
  return (
    <Opts>
      <In mono data-f="org" placeholder="организация" aria-label="Организация" value={org} onInput={(e) => setOrg(e.currentTarget.value)} />
      <Btn pri onClick={create}>
        Создать приложение GitHub
      </Btn>
      {form ? <PostForm form={form} /> : null}
    </Opts>
  );
}

function GhApp({ value }: { value: Gh }) {
  const [gq, setGq] = useState("");
  const repos = value.repos ?? [];
  const q = gq.trim().toLowerCase();
  const shown = repos.filter((r) => !q || r.toLowerCase().includes(q));
  return (
    <>
      <PageHead>
        <M className="st-grow">
          <b>{value.app!.slug}</b>
        </M>
        <Pill tone="ok">{`${repos.length} ${plural(repos.length, "репозиторий", "репозитория", "репозиториев")}`}</Pill>
        {value.install ? (
          <LinkBtn href={value.install} target="_blank" rel="noopener">
            Доступ на GitHub ↗
          </LinkBtn>
        ) : null}
      </PageHead>
      {repos.length ? (
        <>
          <Opts className="st-nowrap">
            <In className="st-grow" data-f="gq" placeholder="Найти репозиторий" aria-label="Найти репозиторий" value={gq} onInput={(e) => setGq(e.currentTarget.value)} />
          </Opts>
          <div className="st-repos">
            {shown.length ? (
              shown.map((r) => (
                <div key={r} className="st-repo" data-repo={r}>
                  <M className="st-grow">{r}</M>
                </div>
              ))
            ) : (
              <Note className="st-repo">Таких нет</Note>
            )}
          </div>
        </>
      ) : null}
    </>
  );
}

function GithubBody() {
  const settings = useSettings();
  const { data: gh, error, reload } = useGithub();
  // GitHub вернул код нового приложения в адресе; сохранено — адрес очищен
  const [code, setCode] = useState(() => new URLSearchParams(location.search).get("code") ?? "");
  const [notes, say] = useOutcome();
  async function save() {
    say("gh", "Сохраняю приложение…");
    const r = await settings.setup(code);
    if (!r.ok) return say("gh", r.error, "bad");
    setCode("");
    reload();
    say("gh", "Приложение сохранено — установите его на репозитории.", "ok");
  }
  return (
    <Sec data-github="">
      <b>Приложение GitHub флота</b>
      {code ? (
        <>
          <span>GitHub вернул код нового приложения.</span>
          <Opts>
            <Btn pri onClick={() => void save()}>
              Сохранить приложение
            </Btn>
          </Opts>
        </>
      ) : error ? (
        <Note tone="bad">{`github.app: ${error}`}</Note>
      ) : !gh ? (
        <Note>…</Note>
      ) : gh.app ? (
        <GhApp value={gh} />
      ) : (
        <GhCreate base={gh.form} refused={(text) => say("gh", text, "bad")} />
      )}
      <Outcome note={notes.gh} />
    </Sec>
  );
}

export function Github() {
  const app = useApp();
  return app.worker("github") ? <GithubBody /> : null;
}

const PUSH: Record<string, string> = { on: "включены", ask: "выключены", error: "не включились", working: "включаю…", denied: "запрещены в браузере", off: "браузер не умеет" };

export function Device() {
  const app = useApp();
  const { data: passes = [] } = usePasses();
  const push = app.use(() => app.mark("alerts.state"));
  const me = thisDevice(passes, app.name);
  return (
    <Sec data-device="">
      <b>Это устройство</b>
      <Row label="адрес">
        <M>{me?.addr ?? app.name}</M>
      </Row>
      <Row label="пропуск">
        <span>
          {me ? "действует" : "—"}
          {app.wide ? (
            <Btn className="st-ml8" onClick={() => app.open("settings", { tab: "passes" })}>
              Пропуска
            </Btn>
          ) : null}
        </span>
      </Row>
      <Row label="уведомления">
        <span data-push={push ?? ""}>{PUSH[push ?? ""] ?? "—"}</span>
      </Row>
    </Sec>
  );
}
