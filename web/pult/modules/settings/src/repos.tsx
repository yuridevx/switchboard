// Репозитории: один список — ключ флота fleet.profiles.repos с честным состоянием по машинам и остальные видимые приложению GitHub; конфликт сводит сессия в клоне.
import { useEffect, useState } from "react";
import { profileIdsOf, type AccountsAnswer, Btn, Confirm, hhmm, In, machineLabel, machinesWith, Note, okOf, Opts, Outcome, type OutcomeNote, plural, profileRepo, type ProfileRepo, Sec, useApp, useModule, wordOf } from "@switchboard/web-ui";
import { PROFILE_REPOS } from "@switchboard/records";
import type { SettingsState } from "./state.ts";

type Line = { m: string; s: ProfileRepo };
const broken = (x: Line) => x.s.state === "conflict" || x.s.state === "error";

/** Сводка по машинам: что сведено, а не что задумано. */
function summary(lines: Line[]): { text: string; tone: string } {
  const n = lines.length;
  const done = lines.filter((x) => x.s.state === "ok");
  const bad = lines.filter(broken);
  if (bad.length) return { text: `${bad.some((x) => x.s.state === "conflict") ? "конфликт" : "ошибка"} на ${bad.length} из ${n}`, tone: "bad" };
  if (!done.length) return { text: "ждёт сведения", tone: "wait" };
  const last = Math.max(0, ...done.map((x) => x.s.at ?? 0));
  const time = last ? ` · ${hhmm(last)}` : "";
  return done.length < n ? { text: `сведён на ${done.length} из ${n}${time}`, tone: "wait" } : { text: `сведён на всех ${n}${time}`, tone: "" };
}
const lineText = (s: ProfileRepo) => (s.state === "ok" ? `сведён${s.at ? ` ${hhmm(s.at)}` : ""}` : s.state === "wait" ? "ждёт сведения" : s.state === "conflict" ? `конфликт: ${(s.files ?? []).join(", ")}` : `ошибка: ${s.error ?? ""}`);

export function ProfileRepos({ github, ready }: { github: string[]; ready: boolean }) {
  const app = useApp();
  const st = useModule<SettingsState>();
  useEffect(() => st.repos.mount(), [st]);
  const machines = app.use(() => machinesWith(app, "machine.profiles"));
  const answers = app.use(() => st.repos.get());
  const all = app.use(() => st.fleet.get<string[]>(PROFILE_REPOS)) ?? [];
  const loaded = app.use(() => st.fleet.ready()) && ready && machines.every((m) => answers[m] !== undefined);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [asking, setAsking] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [outcome, setOutcome] = useState<OutcomeNote | null>(null);
  const pieces = new Map<string, Set<string>>();
  for (const m of machines) for (const id of Object.keys(okOf(answers[m])?.profiles ?? {})) pieces.set(profileRepo(id), (pieces.get(profileRepo(id)) ?? new Set()).add(id));
  /** машина без записи о репозитории его ещё не сводила; отказ машины — её ошибка */
  const linesOf = (repo: string): Line[] => machines.map((m) => ({ m, s: wordOf(answers[m]) ? { state: "error", error: wordOf(answers[m]) } : (okOf(answers[m])?.repos[repo] ?? { state: "wait" }) }));
  const needle = q.trim().toLowerCase();
  const hit = (repo: string) => repo.toLowerCase().includes(needle);
  const listed = [...all].sort().filter(hit);
  const candidates = github.filter((r) => !all.includes(r) && hit(r));
  const sessions = app.use(() => app.roster()?.sessions ?? []);
  const usedBy = (repo: string) => sessions.filter((s) => profileIdsOf(s).some((id) => id.startsWith(`${repo}/`))).map((s) => s.callsign);

  async function sync() {
    setSyncing(true);
    await st.syncRepos();
    setSyncing(false);
  }
  /** Сначала правки на всех машинах, потом сессии: итог стоит в блоке до следующего нажатия. */
  async function reload() {
    setReloading(true);
    setOutcome(null);
    await st.syncRepos();
    const got = await st.reloadSessions();
    setReloading(false);
    const done = got.filter(({ r }) => r.ok).length;
    const bad = got.flatMap(({ callsign, r }) => (r.ok ? [] : [r.why ?? `${callsign}: ${r.error}`]));
    const text = `перечитано ${done} ${plural(done, "сессия", "сессии", "сессий")}`;
    setOutcome({ text: bad.length ? `${text}; не вышло — ${bad.join("; ")}` : text, tone: bad.length ? "bad" : "ok" });
  }
  /** Сессия сведения: клон называет машина, слот — занятый аккаунтом, имя с первым свободным номером. Отправит сведение: токена GitHub у сессии нет. */
  async function resolve(m: string, repo: string, s: ProfileRepo) {
    const seen = await app.read<AccountsAnswer>("machine.accounts", { machine: m });
    const slot = seen.ok ? Object.entries(seen.result.slots).find(([, x]) => x.account)?.[0] : undefined;
    const r = await app.request<{ callsign: string }>("session.open", { machine: m, name: `merge-${repo.split("/")[1]}`, number: true, dir: s.dir, ...(slot ? { slot } : {}) });
    if (!r.ok) return app.toast(`session.open: ${r.error}`, "bad");
    const task = await app.request("session.prompt", { callsign: r.result.callsign, text: `Сведи конфликт репозитория ${repo} в файлах ${(s.files ?? []).join(", ")}: обе версии, закоммить; отправит сведение` });
    app.toast(task.ok ? "сессия сведения открыта" : `${r.result.callsign}: задача не ушла — ${task.error}`, task.ok ? "ok" : "bad");
  }
  const loss = (repo: string) => {
    const who = usedBy(repo);
    return who.length ? `${who.length} ${plural(who.length, "сессия потеряет", "сессии потеряют", "сессий потеряют")} его профили на следующем старте: ${who.join(", ")}` : "Сессии его профилями не пользуются.";
  };
  return (
    <Sec data-profile-repos="">
      <div className="st-prtop">
        <b>Репозитории</b>
        {loaded && all.length ? (
          <Opts>
            <Btn data-act="sync" disabled={syncing || reloading} onClick={() => void sync()}>
              {syncing ? "Свожу…" : "Свести везде"}
            </Btn>
            <Btn data-act="reload" disabled={syncing || reloading} onClick={() => void reload()}>
              {reloading ? "Перечитываю…" : "Перечитать сессии"}
            </Btn>
          </Opts>
        ) : null}
      </div>
      <Outcome note={outcome} />
      {!loaded ? (
        <Note role="status">Читаю состояние машин…</Note>
      ) : (
        <>
          <Opts className="st-nowrap">
            <In className="st-grow" data-f="gq" aria-label="Найти репозиторий" placeholder="Найти репозиторий" value={q} onChange={() => {}} onInput={(e) => setQ(e.currentTarget.value)} />
          </Opts>
          <div className="st-prs">
            {listed.map((repo) => {
              const lines = linesOf(repo);
              const sum = summary(lines);
              const count = pieces.get(repo)?.size ?? 0;
              const used = usedBy(repo).length;
              return (
                <div key={repo} className="st-pr" data-repo={repo} data-prepo={repo}>
                  <div className="st-prh">
                    <b className="sb-m">{repo}</b>
                    <span className="st-prn">{`${count} ${plural(count, "профиль", "профиля", "профилей")} · ${used} ${plural(used, "сессия", "сессии", "сессий")}`}</span>
                    <button type="button" className={`st-prstate ${sum.tone}`} data-state="" aria-expanded={open === repo} onClick={() => setOpen(open === repo ? null : repo)}>
                      {`${sum.text} ${open === repo ? "▴" : "▾"}`}
                    </button>
                    <Btn data-act="unlist" onClick={() => setAsking(repo)}>
                      Убрать…
                    </Btn>
                  </div>
                  {open === repo ? (
                    <div className="st-prm2">
                      {lines.map(({ m, s }) => (
                        <div key={m} data-pm={m}>
                          <b>{machineLabel(app, m).text}</b>
                          <span className={s.state === "wait" ? "wait" : broken({ m, s }) ? "bad" : ""}>{lineText(s)}</span>
                          {s.state === "conflict" ? (
                            <Btn pri data-act="resolve" onClick={() => void resolve(m, repo, s)}>
                              Свести в сессии
                            </Btn>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  ) : null}
                  {asking === repo ? (
                    <Confirm
                      text={`Убрать ${repo}? ${loss(repo)}`}
                      act="Убрать"
                      cancel={() => setAsking(null)}
                      run={() => {
                        setAsking(null);
                        st.fleet.edit<string[]>(PROFILE_REPOS, (old = []) => old.filter((x) => x !== repo));
                      }}
                    />
                  ) : null}
                </div>
              );
            })}
            {candidates.map((r) => (
              <div key={r} className="st-pr" data-repo={r}>
                <div className="st-prh">
                  <span className="sb-m st-grow">{r}</span>
                  <Btn dash data-act="list" onClick={() => st.fleet.edit<string[]>(PROFILE_REPOS, (old = []) => [...old, r])}>
                    Подключить
                  </Btn>
                </div>
              </div>
            ))}
            {listed.length || candidates.length ? null : <Note>Таких нет</Note>}
          </div>
        </>
      )}
    </Sec>
  );
}
