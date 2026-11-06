// Профили — только просмотр: кусочки по репозиториям, итог развёрнутого профиля, свой просмотр у каждого типа содержимого. Живых данных (машин, сессий, сведения) нет.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Btn, effortName, In, IconBtn, Markdown, machinesWith, plural, profileName, profileRepo, RowBtn, Tabs, useApp, useMachineLoad, useModule, type PieceFile, type ProfileInfo, type ProfileMemory, type ProfileName, type ProfilesAnswer, type ProfileTreeNode, type ProfileView } from "@switchboard/web-ui";

/** Что экран помнит между заходами, пока страница открыта. */
export type ProfilesSeen = { seen: { picked: string | null } };

const INDEX_LINES = 200;
const INDEX_BYTES = 25_000;
const PAGE = 60;

type Tab = "sum" | "prompt" | "instr" | "skills" | "agents" | "mem" | "set" | "mcp" | "other";
const kb = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)} МБ` : n >= 1000 ? `${Math.round(n / 1000)} КБ` : `${n} Б`);
const TAGS: Record<string, string> = { set: "набор", style: "стиль" };
type Go = (tab: Tab, focus?: string) => void;
/** находка поиска: своя вкладка и подпись */
const FOUND: Record<ProfileName["kind"], [Tab, string]> = { skill: ["skills", "скил"], agent: ["agents", "агент"], rule: ["instr", "правило"], memory: ["mem", "память"] };
const KINDS = Object.keys(FOUND);
type Jump = { id: string; tab: Tab; focus: string; n: number };
/** ключи элементов: ссылка итога и просмотр вкладки называют элемент одним именем */
const fileKey = (pid: string, path: string) => `${pid}::${path}`;
const mcpKey = (m: ProfileView["mcp"][number], i: number) => `${m.from}::${m.kind}:${m.name}:${i}`;
const line = (v: unknown) => (typeof v === "object" ? JSON.stringify(v) : String(v));
const block = (v: unknown) => (typeof v === "object" ? JSON.stringify(v, null, 2) : String(v));
const filesWord = (n: number) => `${n} ${plural(n, "файл", "файла", "файлов")}`;
const PLUGIN = ".claude-plugin/plugin.json";
/** Память сверху вниз: рядом, затем домашняя — нижний кусочек. */
type Mem = ProfileMemory & { home: boolean };
const memsOf = (view: ProfileView): Mem[] => [...view.memory.near.map((m) => ({ ...m, home: false })), ...(view.memory.home ? [{ ...view.memory.home, home: true }] : [])];

export function ProfilesScreen() {
  const app = useApp();
  const machines = app.use(() => machinesWith(app, "machine.profiles"));
  const machine = machines[0] ?? "";
  const list = useMachineLoad<ProfilesAnswer>(machine, "machine.profiles", {}, !!machine);
  const [q, setQ] = useState("");
  const { seen } = useModule<ProfilesSeen>();
  const [picked, pick] = useState<string | null>(seen.picked);
  const setPicked = (id: string | null) => {
    seen.picked = id;
    pick(id);
  };
  const [jump, setJump] = useState<Jump | null>(null);
  const profiles = list.data?.profiles ?? {};
  const needle = q.trim().toLowerCase();
  const ids = Object.keys(profiles)
    .filter((id) => !needle || `${id} ${profiles[id].about ?? ""} ${(profiles[id].names ?? []).map((x) => x.name).join(" ")}`.toLowerCase().includes(needle))
    .sort((a, b) => profileRepo(a).localeCompare(profileRepo(b)) || Number(profiles[b].kind === "set") - Number(profiles[a].kind === "set") || a.localeCompare(b));
  const groups = [...new Set(ids.map(profileRepo))];
  const found = needle ? Object.entries(profiles).flatMap(([id, p]) => (p.names ?? []).filter((x) => x.name.toLowerCase().includes(needle)).map((x) => ({ id, ...x }))).sort((x, y) => KINDS.indexOf(x.kind) - KINDS.indexOf(y.kind)) : [];
  const cur = picked ?? (app.wide ? ids[0] ?? null : null);
  const go = (hit: (typeof found)[number]) => {
    setJump({ id: hit.id, tab: FOUND[hit.kind][0], focus: fileKey(hit.id, hit.path), n: (jump?.n ?? 0) + 1 });
    setPicked(hit.id);
  };

  const listView = (
    <div className="pv-list" role="listbox" aria-label="Профили">
      <In data-f="q" placeholder="Найти профиль" autoComplete="off" aria-label="Найти профиль" value={q} onChange={() => {}} onInput={(e) => setQ(e.currentTarget.value)} />
      {list.error && !list.stale ? <div className="pv-err">{`machine.profiles: ${list.error}`}</div> : null}
      {groups.map((g) => (
        <div key={g} className="pv-grp">
          <div className="pv-gh">{g}</div>
          {ids
            .filter((id) => profileRepo(id) === g)
            .map((id) => (
              <RowBtn key={id} role="option" aria-selected={id === cur} className="pv-row" data-piece={id} onClick={() => setPicked(id)}>
                <span className="pv-r1">
                  <b>{profileName(id)}</b>
                  {TAGS[profiles[id].kind ?? ""] ? <span className={`pv-tag ${profiles[id].kind}`}>{TAGS[profiles[id].kind!]}</span> : null}
                </span>
              </RowBtn>
            ))}
        </div>
      ))}
      {found.length ? (
        <div className="pv-grp">
          {found.map((x) => (
            <RowBtn key={x.id + x.path} className="pv-row pv-hit" data-hit={fileKey(x.id, x.path)} onClick={() => go(x)}>
              <span className="pv-r1">
                <b>{x.name}</b>
                <span className="pv-tag">{FOUND[x.kind][1]}</span>
              </span>
              <small>{profileName(x.id)}</small>
            </RowBtn>
          ))}
        </div>
      ) : null}
      {needle && !ids.length && !found.length ? <div className="pv-none">{`Ничего не нашлось: «${q.trim()}»`}</div> : null}
      {app.wide ? (
        <button type="button" className="pv-quiet" data-act="repos" onClick={() => app.open("settings", { tab: "general" })}>
          Репозитории
        </button>
      ) : null}
    </div>
  );

  return (
    <div className={app.wide ? "pv wide" : "pv"}>
      {app.wide ? (
        <div className="pv-h">
          <b>Профили</b>
        </div>
      ) : null}
      <div className="pv-b">
        {app.wide || !cur ? listView : null}
        {cur ? <PieceView key={`${cur}:${jump?.id === cur ? jump.n : 0}`} machine={machine} id={cur} info={profiles[cur]} all={profiles} open={setPicked} jump={jump?.id === cur ? jump : undefined} back={app.wide ? undefined : () => setPicked(null)} /> : null}
      </div>
    </div>
  );
}

function PieceView({ machine, id, info, all, open, jump, back }: { machine: string; id: string; info?: ProfileInfo; all: Record<string, ProfileInfo>; open(id: string): void; jump?: Jump; back?: () => void }) {
  const v = useMachineLoad<ProfileView>(machine, "profile.view", { profile: [id] }, !!machine);
  const [tab, setTab] = useState<Tab>(jump?.tab ?? "sum");
  const [focus, setFocus] = useState<string | null>(jump?.focus ?? null);
  const go: Go = (t, f) => {
    setTab(t);
    setFocus(f ?? null);
  };
  const view = v.stale ? undefined : v.data;
  /** источник рядом с именем — только когда кусочков несколько */
  const several = (view?.pieces.length ?? 0) > 1;
  useEffect(() => {
    if (focus) document.querySelector(`[data-focus="${CSS.escape(focus)}"]`)?.scrollIntoView({ block: "start" });
  }, [tab, focus, !!view]);
  const tabs = (
    [
      ["sum", "Итог", false],
      ["prompt", "Промпт", !view],
      ["instr", "Инструкции", !view?.instructions.length],
      ["skills", "Скилы", !view?.skills.length],
      ["agents", "Агенты", !view?.agents.length],
      ["mem", "Память", !view || !memsOf(view).length],
      ["set", "Настройки", !view || !Object.keys(view.settings).length],
      ["mcp", "MCP и хуки", !view?.mcp.length],
      ["other", "Другие файлы", !view?.other.length],
    ] as Array<[Tab, string, boolean]>
  );
  const shown = tabs.some(([k, , off]) => k === tab && !off) ? tab : "sum";
  return (
    <div className="pv-d" data-view={id}>
      <div className="pv-dh">
        {back ? (
          <IconBtn aria-label="К списку" onClick={back}>
            ‹
          </IconBtn>
        ) : null}
        <div className="pv-dt">
          <b>{profileName(id)}</b>
          <span>{[profileRepo(id), info?.about].filter(Boolean).join(" · ")}</span>
        </div>
      </div>
      <Tabs<Tab> className="pv-tabs" tabs={tabs} cur={shown} pick={(t) => go(t)} data-vtabs="" />
      {v.error && !v.stale ? <div className="pv-err">{`profile.view: ${v.error}`}</div> : null}
      {!view ? <div className="pv-none">читаю…</div> : null}
      {view ? (
        <div className="pv-body" data-tab-body={shown}>
          {shown === "sum" ? <Dashboard machine={machine} id={id} info={all[id]} view={view} go={go} open={open} /> : null}
          {shown === "prompt" ? <Prompt machine={machine} view={view} focus={focus} /> : null}
          {shown === "instr" ? <Items focus={focus} items={view.instructions.map((i) => ({ ...fileItem(machine, i.from, i.path, i.path, [i.rule ? "правило" : "", i.paths ? `когда ${i.paths}` : "всегда"].filter(Boolean).join(" · ")), pid: several ? i.from : undefined }))} /> : null}
          {shown === "skills" ? <Items focus={focus} items={view.skills.map((s) => skillItem(machine, s))} /> : null}
          {shown === "agents" ? <Items focus={focus} items={view.agents.map((a) => ({ ...fileItem(machine, a.from, a.path, a.name, [a.main ? "главная нить" : "", a.model, a.effort ? effortName(a.effort) : "", a.description].filter(Boolean).join(" · ")), pid: undefined }))} /> : null}
          {shown === "mem" ? memsOf(view).map((m) => <Memory key={m.from} machine={machine} view={view} m={m} focus={focus} />) : null}
          {shown === "set" ? <Settings view={view} focus={focus} /> : null}
          {shown === "mcp" ? <Items focus={focus} items={view.mcp.map((m, i) => ({ key: mcpKey(m, i), pid: several ? m.from : undefined, title: m.kind === "server" ? m.name : `хук ${m.name}`, sub: m.detail, body: () => <pre className="pv-pre">{block(m.config)}</pre> }))} /> : null}
          {shown === "other" ? <Items focus={focus} items={view.other.map((o) => ({ ...fileItem(machine, o.from, o.path, o.path), pid: several ? o.from : undefined }))} /> : null}
        </div>
      ) : null}
    </div>
  );
}

const fileOf = (view: ProfileView, pid: string, path: string): PieceFile | undefined => view.files[pid]?.find((f) => f.path === path);
const Src = ({ id }: { id: string }) => <span className="pv-src">{profileName(id)}</span>;
function Meter({ lines, bytes }: { lines: number; bytes: number }) {
  const part = Math.min(1, Math.max(lines / INDEX_LINES, bytes / INDEX_BYTES));
  return (
    <div className={part > 0.8 ? "pv-meter hot" : "pv-meter"} title="индекс памяти против предела Claude: 200 строк и 25 000 байт">
      <i style={{ width: `${Math.round(part * 100)}%` }} />
      <span>{`индекс ${lines} из ${INDEX_LINES} строк · ${(bytes / 1000).toFixed(1)} из 25 КБ`}</span>
    </div>
  );
}

/** Раздел итога: заголовок — ссылка на вкладку, ниже все имена столбиком. */
function Tile({ title, tab, go, items }: { title: string; tab: Tab; go: Go; items: ReactNode[] }) {
  return (
    <section className="pv-tile" data-tile={tab}>
      <button type="button" className="pv-tt" data-link={`${tab}|`} onClick={() => go(tab)}>
        {title}
      </button>
      <ul>
        {items.map((x, i) => (
          <li key={i}>{x}</li>
        ))}
      </ul>
    </section>
  );
}
const Lk = ({ children, on, ...p }: { children: ReactNode; on(): void; "data-link": string }) => (
  <button type="button" className="pv-lk" onClick={on} {...p}>
    {children}
  </button>
);
/** Ссылка итога на элемент вкладки: data-link — «вкладка|элемент». */
const To = ({ children, tab, at, go }: { children: ReactNode; tab: Tab; at: string; go: Go }) => (
  <Lk on={() => go(tab, at)} data-link={`${tab}|${at}`}>
    {children}
  </Lk>
);
function DashTree({ nodes, view, open, own }: { nodes: ProfileTreeNode[]; view: ProfileView; open(id: string): void; own: string }) {
  return (
    <ul className="pv-dtree">
      {nodes.map((n, i) => (
        <li key={`${n.id}:${i}`}>
          {n.set ? null : <span className="pv-num">{view.pieces.indexOf(n.id) + 1}</span>}
          {n.id === own ? <b>{profileName(n.id)}</b> : <Lk on={() => open(n.id)} data-link={`piece|${n.id}`}>{profileName(n.id)}</Lk>}
          {n.set ? <span className="pv-tag set">набор</span> : null}
          {n.children ? <DashTree nodes={n.children} view={view} open={open} own={own} /> : null}
        </li>
      ))}
    </ul>
  );
}
/** Строка YAML: значение с двоеточием или решёткой — в кавычках. */
const yamlText = (v: string) => (/[:#]/.test(v) ? JSON.stringify(v) : v);
type Manifest = { name: string; description?: string; use?: string[] };
const manifestText = (text: string, id: string): Manifest => {
  try {
    const m = JSON.parse(text) as { name?: string; description?: string; metadata?: { use?: string[] } };
    return { name: m.name ?? profileName(id), description: m.description, use: m.metadata?.use };
  } catch {
    return { name: profileName(id) };
  }
};
/** Манифест кусочка: свой plugin.json, текст по запросу; файла нет — имя папки и ничего больше. */
function ManifestPart({ machine, id, has, open }: { machine: string; id: string; has: boolean; open(id: string): void }) {
  const got = useMachineLoad<{ text: string }>(machine, "profile.file", { id, path: PLUGIN }, has);
  if (!has) return <span className="pv-dim">без манифеста</span>;
  if (got.error && !got.stale) return <div className="pv-err">{`profile.file: ${got.error}`}</div>;
  if (!got.data || got.stale) return <div className="pv-none">читаю…</div>;
  const m = manifestText(got.data.text, id);
  return (
    <pre className="pv-yaml">
      <i>name:</i> {yamlText(m.name)}
      {"\n"}
      {m.description ? (
        <>
          <i>description:</i> {yamlText(m.description)}
          {"\n"}
        </>
      ) : null}
      {m.use ? (
        <>
          <i>metadata:</i>
          {"\n"}
          {"  "}
          <i>use:</i>
          {"\n"}
          {m.use.map((u) => (
            <span key={u}>
              {"    - "}
              <Lk on={() => open(u)} data-link={`piece|${u}`}>
                {u}
              </Lk>
              {"\n"}
            </span>
          ))}
        </>
      ) : null}
    </pre>
  );
}
/** Итог: разделы сверху вниз, внутри только имена со ссылками на свои вкладки. */
function Dashboard({ machine, id, view, go, open }: { machine: string; id: string; info?: ProfileInfo; view: ProfileView; go: Go; open(id: string): void }) {
  const sets = Object.entries(view.settings);
  const mems = memsOf(view);
  const p = view.prompt;
  const layers = [
    <To key="b" tab="prompt" at="prompt:base" go={go}>
      <span className={p.agent ? "pv-off" : undefined}>{p.agent ? "основа Claude Code заменена агентом" : "основа Claude Code"}</span>
    </To>,
    ...(p.agent ? [<To key="a" tab="prompt" at="prompt:agent" go={go}>{`агент ${p.agent.name}`}</To>] : []),
    ...(p.style ? [<To key="s" tab="prompt" at="prompt:style" go={go}>{`стиль ${p.style.name}`}</To>] : []),
    <To key="y" tab="prompt" at="prompt:sys" go={go}>
      добавка системы
    </To>,
  ];
  const tiles: Array<[string, number, Tab, ReactNode[]]> = [
    ["Промпт", layers.length, "prompt", layers],
    ["Инструкции", view.instructions.length, "instr", view.instructions.map((i) => <To key={i.from + i.path} tab="instr" at={fileKey(i.from, i.path)} go={go}>{`${profileName(i.from)} · ${i.rule ? `правило ${i.path.split("/").pop()}` : i.path}`}</To>)],
    ["Скилы", view.skills.length, "skills", view.skills.map((k) => <To key={k.name} tab="skills" at={fileKey(k.from, k.path)} go={go}>{k.name}</To>)],
    ["Агенты", view.agents.length, "agents", view.agents.map((a) => <To key={a.name} tab="agents" at={fileKey(a.from, a.path)} go={go}>{a.name}</To>)],
    ["Память", mems.length, "mem", [...mems].reverse().map((m) => <To key={m.from} tab="mem" at={`mem:${m.from}`} go={go}>{`${profileName(m.from)} · ${m.home ? "домашняя" : "рядом"} · ${filesWord(m.files)}`}</To>)],
    ["Настройки", sets.length, "set", sets.map(([k, v]) => (
      <To key={k} tab="set" at={`set:${k}`} go={go}>
        {`${k} = ${line(v.value)}`}
        {v.lost.map((l, i) => <s key={i}>{line(l.value)}</s>)}
      </To>
    ))],
    ["MCP и хуки", view.mcp.length, "mcp", view.mcp.map((m, i) => <To key={i} tab="mcp" at={mcpKey(m, i)} go={go}>{m.kind === "server" ? m.name : `хук ${m.name}`}</To>)],
    ["Другие файлы", view.other.length, "other", view.other.map((o) => <To key={o.from + o.path} tab="other" at={fileKey(o.from, o.path)} go={go}>{`${profileName(o.from)} · ${o.path}`}</To>)],
  ];
  return (
    <div className="pv-dash">
      <section className="pv-tile" data-tile="tree">
        <div className="pv-tt static">
          Состав
        </div>
        <DashTree nodes={view.tree} view={view} open={open} own={id} />
      </section>
      <section className="pv-tile" data-tile="manifest">
        <div className="pv-tt static">Манифест</div>
        <ManifestPart machine={machine} id={id} has={!!fileOf(view, id, PLUGIN)} open={open} />
      </section>
      {tiles.filter(([, n]) => n).map(([title, , tab, items]) => (
        <Tile key={title} title={title} tab={tab} go={go} items={items} />
      ))}
    </div>
  );
}

/** Строка просмотра: закрыта, пока её не открыли или на неё не вела ссылка итога. */
type Item = { key: string; pid?: string; title: string; sub?: string; size?: string; off?: boolean; body(): ReactNode };
const fileItem = (machine: string, pid: string, path: string, title: string, sub?: string, key = fileKey(pid, path)): Item => ({
  key,
  pid,
  title,
  sub,
  body: () => <FileText machine={machine} id={pid} path={path} />,
});
function skillItem(machine: string, s: ProfileView["skills"][number]): Item {
  const dir = s.path.slice(0, s.path.lastIndexOf("/") + 1);
  const main = fileItem(machine, s.from, s.path, s.name, s.description);
  return {
    ...main,
    pid: undefined,
    body: () => (
      <>
        {main.body()}
        {s.extra.length ? <Items items={s.extra.map((p) => ({ ...fileItem(machine, s.from, p, p.slice(dir.length)), pid: undefined }))} /> : null}
      </>
    ),
  };
}
function Items({ items, focus }: { items: Item[]; focus?: string | null }) {
  const [open, setOpen] = useState<string | null>(focus ?? null);
  return (
    <div className="pv-files">
      {items.map((it) => (
        <div key={it.key} className={open === it.key ? "pv-file on" : "pv-file"} data-focus={focus === it.key ? it.key : undefined}>
          <RowBtn className="pv-fh" data-file={it.key} aria-expanded={open === it.key} onClick={() => setOpen(open === it.key ? null : it.key)}>
            {it.pid ? <Src id={it.pid} /> : null}
            <b className={it.off ? "pv-off" : undefined}>{it.title}</b>
            {it.size ? <em>{it.size}</em> : null}
            {it.sub ? <span>{it.sub}</span> : null}
          </RowBtn>
          {open === it.key ? <div className="pv-fb">{it.body()}</div> : null}
        </div>
      ))}
    </div>
  );
}
/** шапка файла: имя и описание уже в строке просмотра */
const FRONT = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;
function FileText({ machine, id, path }: { machine: string; id: string; path: string }) {
  const got = useMachineLoad<{ text: string }>(machine, "profile.file", { id, path });
  if (got.error && !got.stale) return <div className="pv-err">{got.error === "too_large" ? "файл больше предела просмотра" : `profile.file: ${got.error}`}</div>;
  if (!got.data || got.stale) return <div className="pv-none">читаю…</div>;
  return path.endsWith(".md") ? (
    <div className="pv-text">
      <Markdown text={got.data.text.replace(FRONT, "")} />
    </div>
  ) : (
    <pre className="pv-pre">{got.data.text}</pre>
  );
}

/** Всё, что получит сессия, в порядке сборки: системный промпт, затем контекст. Основы в кусочках нет — показано, что про неё известно. */
function Prompt({ machine, view, focus }: { machine: string; view: ProfileView; focus?: string | null }) {
  const fleet = useMachineLoad<{ text: string }>(machine, "fleet.prompt").data?.text ?? "";
  const p = view.prompt;
  const near = view.memory.near.filter((m) => m.indexLines);
  const home = view.memory.home?.indexLines ? view.memory.home : undefined;
  const missing = (key: string, title: string, why: string): Item => ({ key, title, sub: why, body: () => <div className="pv-err">{why}</div> });
  const part = (pid: string, path: string, title: string, sub: string | undefined, key: string): Item & { bytes: number } => {
    const bytes = fileOf(view, pid, path)?.size ?? 0;
    return { ...fileItem(machine, pid, path, title, sub, key), pid: undefined, size: kb(bytes), bytes };
  };
  const index = (m: ProfileMemory, key?: string) => ({ ...fileItem(machine, m.from, "memory/MEMORY.md", `индекс памяти ${profileName(m.from)}`, undefined, key), pid: undefined, size: kb(m.indexBytes) });
  const styleMeta = p.style?.path ? fileOf(view, p.style.from, p.style.path)?.meta : undefined;
  const agent = p.agent?.path ? part(p.agent.from, p.agent.path, `Агент ${p.agent.name}`, view.agents.find((a) => a.main)?.description, "prompt:agent") : undefined;
  const style = p.style?.found && p.style.path ? part(p.style.from, p.style.path, `Стиль ${p.style.name}`, styleMeta?.description, "prompt:style") : undefined;
  const sysBytes = fleet.length + near.reduce((n, m) => n + m.indexBytes, 0);
  const system: Item[] = [
    {
      key: "prompt:base",
      title: "Основа Claude Code",
      sub: p.agent ? `заменена агентом ${p.agent.name}` : undefined,
      off: !!p.agent,
      body: () => <div className="pv-text">{"Встроена в Claude Code: инструменты и правила работы с кодом. Текста во флоте нет."}</div>,
    },
    ...(p.agent ? [agent ?? missing("prompt:agent", `Агент ${p.agent.name}`, "файла агента нет в профиле")] : []),
    ...(p.style ? [style ?? missing("prompt:style", `Стиль ${p.style.name}`, "стиль не найдётся — нужно полное имя, «профиль:стиль»")] : []),
    {
      key: "prompt:sys",
      title: "Добавка системы",
      size: kb(sysBytes),
      body: () => (
        <>
          <pre className="pv-pre">{fleet}</pre>
          {near.length ? <Items items={near.map((m) => index(m))} /> : null}
        </>
      ),
    },
  ];
  const instr = view.instructions.map((i) => part(i.from, i.path, `${profileName(i.from)} · ${i.path}`, [i.rule ? "правило" : "", i.paths ? `когда ${i.paths}` : "всегда"].filter(Boolean).join(" · "), `prompt:${fileKey(i.from, i.path)}`));
  const context: Item[] = [...instr, ...(home ? [index(home, "prompt:home")] : [])];
  const systemBytes = (agent?.bytes ?? 0) + (style?.bytes ?? 0) + sysBytes;
  const contextBytes = instr.reduce((n, i) => n + i.bytes, 0) + (home?.indexBytes ?? 0);
  return (
    <div className="pv-parts">
      <div className="pv-ph">
        <b>Системный промпт</b>
        <em>{kb(systemBytes)}</em>
      </div>
      <Items items={system} focus={focus} />
      {context.length ? (
        <>
          <div className="pv-ph">
            <b>Контекст</b>
            <em>{kb(contextBytes)}</em>
          </div>
          <Items items={context} focus={focus} />
        </>
      ) : null}
    </div>
  );
}

/** Настройки итогом слияния: ключ, значение, источник и проигравшие значения. */
function Settings({ view, focus }: { view: ProfileView; focus?: string | null }) {
  return (
    <div className="pv-sets">
      {Object.entries(view.settings).map(([k, s]) => {
        const key = `set:${k}`;
        return (
          <div key={k} className={focus === key ? "pv-sr on" : "pv-sr"} data-focus={focus === key ? key : undefined}>
            <code>{k}</code>
            <div className="pv-sv">
              <pre>{block(s.value)}</pre>
              {s.lost.map((l, i) => (
                <div key={i} className="pv-sl">
                  <s>{block(l.value)}</s>
                  <Src id={l.from} />
                </div>
              ))}
            </div>
            <Src id={s.from} />
          </div>
        );
      })}
    </div>
  );
}

const TYPE_RU: Record<string, string> = { feedback: "отзыв", project: "проект", reference: "ссылка", user: "о человеке" };
const typeName = (t: string) => TYPE_RU[t] ?? (t || "без типа");

function Memory({ machine, view, m, focus }: { machine: string; view: ProfileView; m: Mem; focus?: string | null }) {
  const from = m.from;
  const files = (view.files[from] ?? []).filter((f) => f.path.startsWith("memory/") && f.path !== "memory/MEMORY.md");
  const all = files.filter((f) => f.path.endsWith(".md")).sort((x, y) => (x.meta?.name ?? x.path).localeCompare(y.meta?.name ?? y.path));
  const service = files.length - all.length;
  const [q, setQ] = useState("");
  /** выбранный тип как в заголовке файла; null — все */
  const [type, setType] = useState<string | null>(null);
  /** файл из находки поиска открыт и попадает в порцию */
  const wanted = focus?.startsWith(`${from}::`) ? focus : null;
  const [n, setN] = useState(wanted ? Math.max(PAGE, all.findIndex((f) => fileKey(from, f.path) === wanted) + 1) : PAGE);
  const [open, setOpen] = useState<string | null>(wanted);
  const needle = q.trim().toLowerCase();
  const rawType = (f: PieceFile) => f.meta?.type ?? "";
  const hits = useMemo(() => all.filter((f) => (type === null || rawType(f) === type) && (!needle || `${f.path} ${f.meta?.name ?? ""} ${f.meta?.description ?? ""}`.toLowerCase().includes(needle))), [all, type, needle]); // eslint-disable-line react-hooks/exhaustive-deps
  const index = view.files[from]?.find((f) => f.path === "memory/MEMORY.md");
  const [showIndex, setShowIndex] = useState(false);
  const own = `mem:${from}`;
  return (
    <div className={m.home ? "pv-mem home" : "pv-mem"} data-memory={from} data-focus={focus === own ? own : undefined}>
      <div className="pv-mh">
        {memsOf(view).length > 1 ? <Src id={from} /> : null}
        <b>{m.home ? "домашняя" : "рядом: индекс в промпте"}</b>
        <span className="pv-chip">{`${filesWord(m.files)} · ${kb(m.bytes)}`}</span>
      </div>
      <Meter lines={m.indexLines} bytes={m.indexBytes} />
      <div className="pv-types">
        <button type="button" className={type !== null ? "pv-chip btn" : "pv-chip btn on"} onClick={() => setType(null)}>
          все
        </button>
        {Object.entries(m.types)
          .sort((a, b) => b[1] - a[1])
          .map(([t]) => (
            <button key={t} type="button" className={type === t ? "pv-chip btn on" : "pv-chip btn"} data-mtype={t} onClick={() => setType(type === t ? null : t)}>
              {typeName(t)}
            </button>
          ))}
        {index ? (
          <button type="button" className={showIndex ? "pv-chip btn on" : "pv-chip btn"} onClick={() => setShowIndex(!showIndex)}>
            MEMORY.md
          </button>
        ) : null}
        {service ? <span className="pv-note">{`и ${service} служебных файлов`}</span> : null}
      </div>
      {showIndex && index ? <FileText machine={machine} id={from} path="memory/MEMORY.md" /> : null}
      <In data-f="mq" placeholder="Найти в памяти" autoComplete="off" aria-label="Найти в памяти" value={q} onChange={() => {}} onInput={(e) => { setQ(e.currentTarget.value); setN(PAGE); }} />
      <div className="pv-ml">
        {hits.slice(0, n).map((f) => {
          const key = `${from}::${f.path}`;
          return (
            <div key={f.path} className={open === key ? "pv-mi on" : "pv-mi"} data-focus={focus === key ? key : undefined}>
              <RowBtn className="pv-mr" data-mem={f.path} onClick={() => setOpen(open === key ? null : key)}>
                <span className="pv-mt">{typeName(rawType(f))}</span>
                <b>{f.meta?.name ?? f.path.replace(/^memory\//, "")}</b>
                <span className="pv-kb">{kb(f.size)}</span>
                {f.meta?.description ? <span className="pv-md">{f.meta.description}</span> : null}
              </RowBtn>
              {open === key ? <FileText machine={machine} id={from} path={f.path} /> : null}
            </div>
          );
        })}
        {hits.length > n ? (
          <Btn className="pv-more" onClick={() => setN(n + PAGE)}>
            {`ещё ${Math.min(PAGE, hits.length - n)} из ${hits.length - n}`}
          </Btn>
        ) : null}
      </div>
    </div>
  );
}
