// Вкладка «GitHub и устройство»: приложение GitHub флота и его репозитории; адрес, пропуск и уведомления этого устройства.
import { useEffect, useRef, useState } from "react";
import type {} from "@switchboard/web-alerts";
import { Btn, In, LinkBtn, M, Note, Opts, PageHead, Pill, plural, Row, Sec, useApp } from "@switchboard/web-ui";
import { useSettings } from "./store.ts";
import { NoteOf, StoredIn } from "./parts.tsx";
import type { Form, Gh } from "./store.ts";

/** Форма manifest уходит в браузере на github.com; GitHub вернёт страницу с ?code=. */
export function PostForm({ form, sent }: { form: Form; sent(): void }) {
  const el = useRef<HTMLFormElement>(null);
  useEffect(() => {
    el.current?.submit();
    sent();
  }, [sent]);
  return (
    <form ref={el} method="post" action={form.action} hidden>
      <input type="hidden" name="manifest" value={JSON.stringify(form.manifest)} />
    </form>
  );
}

function GhCreate() {
  const settings = useSettings();
  const [org, setOrg] = useState("");
  return (
    <Opts>
      <In mono data-f="org" placeholder="организация" aria-label="Организация" value={org} onInput={(e) => setOrg(e.currentTarget.value)} />
      <Btn pri onClick={() => void settings.create(org.trim())}>
        Создать приложение GitHub
      </Btn>
    </Opts>
  );
}

function GhApp({ value }: { value: Gh }) {
  const app = useApp();
  const settings = useSettings();
  const gq = app.use(() => settings.get().gq);
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
        <Opts className="st-nowrap">
          <StoredIn className="st-grow" data-f="gq" placeholder="Найти репозиторий" aria-label="Найти репозиторий" initial={gq} onValue={settings.setRepoQuery} />
        </Opts>
      ) : null}
      {repos.length ? (
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
      ) : null}
    </>
  );
}

export function Github() {
  const app = useApp();
  const settings = useSettings();
  const gh = app.use(() => settings.get().gh);
  const ghCode = app.use(() => settings.get().ghCode);
  if (!app.worker("github")) return null;
  return (
    <Sec data-github="">
      <b>Приложение GitHub флота</b>
      {ghCode ? (
        <>
          <span>GitHub вернул код нового приложения.</span>
          <Opts>
            <Btn pri onClick={() => void settings.setup()}>
              Сохранить приложение
            </Btn>
          </Opts>
        </>
      ) : !gh ? (
        <Note>…</Note>
      ) : "error" in gh ? (
        <Note tone="bad">{`github.app: ${gh.error}`}</Note>
      ) : gh.app ? (
        <GhApp value={gh} />
      ) : (
        <GhCreate />
      )}
      <NoteOf k="gh" />
    </Sec>
  );
}

const PUSH: Record<string, string> = { on: "включены", ask: "выключены", error: "не включились", working: "включаю…", denied: "запрещены в браузере", off: "браузер не умеет" };

export function Device() {
  const app = useApp();
  const settings = useSettings();
  const passes = app.use(() => settings.get().passes);
  const push = app.use(() => app.mark("alerts.state"));
  const ps = passes && !("error" in passes) ? passes : [];
  const me = ps.find((p) => p.role === "client" && p.name === app.name);
  return (
    <Sec data-device="">
      <b>Это устройство</b>
      <Row label="адрес">
        <M>{me?.addr ?? app.name}</M>
      </Row>
      <Row label="пропуск">
        <span>
          {me ? (me.state === "ok" ? "действует" : "ждёт приёма") : "—"}
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
