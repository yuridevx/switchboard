// pult-profiles — профили флота: ответы machine.profiles всех машин, сведённые в строки по id. Конфликт — состояние репозитория профиля на машине.
// Раньше сводили «Машины» и «Настройки»; теперь это единственный экран профилей.
import { useEffect, useState } from "react";
import type { App, AppModule, Roster } from "@switchboard/web-core";
import type {} from "@switchboard/web-labels";
import { machineOf } from "@switchboard/protocol";
import { Btn, Dot, effortName, plural, profileName as short, folderOf, stateLabel } from "@switchboard/web-ui";
import css from "./profiles.css";

type Repo = { state: "ok" | "error" | "conflict"; files?: string[]; error?: string };
type Answer = { profiles: Record<string, { model?: string | null; effort?: string | null; about?: string }>; repos: Record<string, Repo> };

const repoOf = (id: string) => id.slice(0, id.lastIndexOf("/"));

/** Новый модуль со своей памятью (в выпуске — один; в тестах — на каждый прогон). */
export function createProfiles(): AppModule {
  let app: App;
  const answers = new Map<string, Answer | { error: string }>();
  /** открытые экраны: машина, пришедшая при открытом экране, спрашивается сразу */
  let opened = 0;

  const can = (m: string) => app.can(m, "machine.profiles") === true;
  const machines = () => (app.roster()?.machines ?? []).map((m) => m.machine).filter(can);
  const mLabel = (m: string) => app.mark("label.machine", m)?.text ?? `@${m}`;

  async function load(m: string, sync = false) {
    const r = await app.request<Answer>("machine.profiles", sync ? { machine: m, sync: true } : { machine: m });
    answers.set(m, r.ok ? r.result : { error: r.error });
    app.changed();
  }

  /** Строки: id → машины, описание и модель первой ответившей, машины с конфликтом. */
  function rows() {
    const out = new Map<string, { id: string; about: string; model: string; effort: string; ms: string[]; cf: Array<{ m: string; repo: Repo }> }>();
    for (const [m, a] of answers) {
      if ("error" in a) continue;
      for (const [id, p] of Object.entries(a.profiles)) {
        const row = out.get(id) ?? { id, about: p.about ?? "", model: p.model ?? "", effort: p.effort ?? "", ms: [], cf: [] };
        row.ms.push(m);
        out.set(id, row);
        const repo = a.repos[repoOf(id)];
        if (!repo || repo.state === "ok") continue;
        // файлы конфликта — под папками профилей: конфликт у того, чьи файлы; ни под чьей — у всех профилей репозитория
        const files = repo.files ?? [];
        const own = files.filter((f) => f.startsWith(`${short(id)}/`));
        const anyone = files.some((f) => Object.keys(a.profiles).some((x) => f.startsWith(`${short(x)}/`)));
        if (own.length || !anyone) row.cf.push({ m, repo: { ...repo, files: own.length ? own : files } });
      }
    }
    return [...out.values()];
  }

  /** Всё, что показывает экран: простые данные, сравниваются по содержимому. */
  function summary() {
    const sessions = app.roster()?.sessions ?? [];
    return {
      all: rows().map((r) => ({
        ...r,
        ms: r.ms.map((m) => ({ m, label: mLabel(m) })),
        cf: r.cf.map((x) => ({ ...x, label: mLabel(x.m) })),
        run: sessions
          .filter((s) => (s.profile as { id?: string } | null | undefined)?.id === r.id)
          .map((s) => {
            const n = app.mark("label.session", s.callsign) ?? { text: s.callsign, human: false };
            return { callsign: s.callsign, lamp: s.state === "failed" ? "bad" : stateLabel(s.state).dot || "stop", text: n.text, human: n.human, place: `${mLabel(machineOf(s.callsign) ?? "")} · ${folderOf(s.dir)}` };
          }),
      })),
      repos: [...new Set([...answers.values()].flatMap((a) => ("error" in a ? [] : Object.keys(a.repos))))],
      errors: [...answers].flatMap(([m, a]) => ("error" in a ? [`${mLabel(m)}: machine.profiles: ${a.error}`] : [])),
      machines: machines().length,
    };
  }

  function Profiles() {
    const { all, repos, errors, machines: nm } = app.use(summary);
    const [q, setQ] = useState("");
    const [onlyCf, setOnlyCf] = useState(false);
    const [exp, setExp] = useState<string | null>(null);
    const [syncing, setSyncing] = useState(false);

    useEffect(() => {
      opened++;
      for (const m of machines()) void load(m);
      return () => void opened--;
    }, []);

    async function syncAll() {
      setSyncing(true);
      await Promise.all(machines().map((m) => load(m, true)));
      setSyncing(false);
      const cf = rows().flatMap((r) => r.cf.map((x) => `${short(r.id)} ${mLabel(x.m)}`));
      app.toast(cf.length ? `Сведено. Конфликт: ${cf.join(", ")}` : "Сведено", cf.length ? "bad" : "ok");
    }

    const ql = q.trim().toLowerCase();
    const ncf = all.filter((r) => r.cf.length).length;
    if (!ncf && onlyCf) setOnlyCf(false);
    const shown = all
      .filter((r) => (!ql || `${r.id} ${r.about}`.toLowerCase().includes(ql)) && (!(onlyCf && ncf) || r.cf.length))
      .sort((a, b) => (b.cf.length ? 1 : 0) - (a.cf.length ? 1 : 0) || short(a.id).localeCompare(short(b.id)));
    return (
      <div className={"pf" + (app.wide ? " wide" : "")}>
        <div className="pf-h">
          {app.wide ? <b>Профили</b> : null}
          <span className="pf-repo">{repos.join(", ")}</span>
          <Btn data-act="sync" disabled={syncing} onClick={() => void syncAll()}>
            {syncing ? "Свожу…" : "Синхронизировать"}
          </Btn>
        </div>
        <div className="pf-b">
          <div className="pf-t">
            <input data-f="q" defaultValue="" placeholder={`Найти профиль · ${all.length}`} autoComplete="off" aria-label="Найти профиль" onInput={(e) => setQ(e.currentTarget.value)} />
            {ncf ? (
              <Btn data-act="conflicts" aria-pressed={onlyCf} onClick={() => setOnlyCf(!onlyCf)}>
                {`конфликты ${ncf}`}
              </Btn>
            ) : null}
          </div>
          {errors.map((e) => (
            <div key={e} className="pf-e" role="alert">
              {e}
            </div>
          ))}
          <div className="pf-l">
            {shown.length ? (
              shown.map((r) => {
                const open = exp === r.id;
                return (
                  <div key={r.id} className={"pf-w" + (r.cf.length ? " cf" : "")} data-profile={r.id}>
                    <button className="pf-r" aria-expanded={open} onClick={() => setExp(open ? null : r.id)}>
                      <span className="pf-n">
                        <b>{short(r.id)}</b>
                        {r.about ? <span>{r.about}</span> : null}
                      </span>
                      <span className="pf-m">
                        <span>{[r.model, r.effort ? effortName(r.effort) : null].filter(Boolean).join(" · ")}</span>
                        <span className="c">{`${r.ms.length}/${nm} ${plural(nm, "машины", "машин", "машин")} · ${r.run.length} ${plural(r.run.length, "сессия", "сессии", "сессий")}`}</span>
                        {r.cf.length ? <span className="pf-p bad">{`конфликт ${r.cf.map((x) => x.label).join(", ")}`}</span> : null}
                      </span>
                    </button>
                    {open ? (
                      <div className="pf-d">
                        <div className="pf-ms">
                          {r.ms.map(({ m, label }) =>
                            r.cf.some((x) => x.m === m) ? (
                              <span key={m} className="pf-p bad">{`${label} конфликт`}</span>
                            ) : (
                              <span key={m} className="pf-p ok">
                                {label}
                              </span>
                            ),
                          )}
                        </div>
                        {r.run.length ? (
                          <div className="pf-ss">
                            {r.run.map((s) => (
                              <button key={s.callsign} data-callsign={s.callsign} onClick={() => app.open("card", { callsign: s.callsign })}>
                                <Dot kind={s.lamp} />
                                <span className={"nm" + (s.human ? " hum" : "")}>{s.text}</span>
                                <span className="k">{s.place}</span>
                              </button>
                            ))}
                          </div>
                        ) : null}
                        {r.cf.map((x) => (
                          <div key={x.m} className="pf-cf">
                            <b>{`${x.label}: ${x.repo.state === "conflict" ? "конфликт" : "ошибка"}`}</b>
                            {x.repo.error ? <span>{x.repo.error}</span> : null}
                            {(x.repo.files ?? []).map((f) => (
                              <code key={f}>{f}</code>
                            ))}
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </div>
                );
              })
            ) : (
              <div className="pf-none">профилей нет</div>
            )}
          </div>
        </div>
      </div>
    );
  }

  return {
    on: {
      roster(r: Roster) {
        // машина пришла при открытом экране — спросить и её
        if (opened) for (const x of r.machines) if (!answers.has(x.machine) && can(x.machine)) void load(x.machine);
      },
    },
    screens: { profiles: { nav: "Профили", group: "Флот", label: "Профили", path: "profiles", view: Profiles, head: () => ({ title: "Профили" }) } },
    css,
    start(a) {
      app = a;
    },
  };
}
