// «Флот → Профили»: кусочки на машине, репозитории и их клоны, сведение, просмотр набора по вкладкам.
import { prefsGet, prefsSet, profileFile, profileList, profileSync, profileView, sessionCall, sessionOpen, type OutputOf, type Piece, type RepoClone, type SessionRow } from "@sb/protocol";
import { ActionIcon, Badge, Button, Checkbox, Chip, Group, Loader, Select, Stack, Text, TextInput } from "@mantine/core";
import { Page } from "../../shell/Page.tsx";
import { notifications } from "@mantine/notifications";
import { IconArrowLeft, IconSearch, IconTrash } from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { act, api, sayError } from "../../api.ts";
import { confirmDanger, Failed, useCall, useWide } from "../../common.tsx";
import { useLocal } from "../../lib/local.ts";
import { ago, bytesWord, count, nFiles, nSessions } from "../../lib/time.ts";
import { useFleet } from "../../store/fleet.ts";

type View = OutputOf<typeof profileView>;
type Item = View["items"][number];
type TreeNode = { id: string; set: boolean; children?: TreeNode[] };

export const VIEW_TABS: Array<[string, string, string[]]> = [
  ["sum", "Итог", []], ["prompt", "Промпт", []], ["rules", "Инструкции", ["instructions", "rule"]], ["skills", "Скилы", ["skill"]], ["agents", "Агенты", ["agent"]],
  ["commands", "Команды", ["command"]], ["hooks", "Хуки", ["hook"]], ["mcp", "MCP", ["mcp"]], ["settings", "Настройки", []], ["memory", "Память", ["memory"]], ["files", "Файлы", []],
];
const KIND_WORD: Record<string, string> = { skill: "скилы", agent: "агенты", rule: "правила", instructions: "инструкции", mcp: "серверы MCP", hook: "хуки", setting: "настройки", memory: "память", command: "команды" };
export const CLONE_WORD: Record<RepoClone["state"], string> = { ok: "сведён", wait: "ещё не сводился", conflict: "слияние ждёт сессию", error: "ошибка" };

/** Сколько чего в наборе — для вкладки «Итог». */
export function summary(items: Item[]): Array<[string, number]> {
  const by = new Map<string, number>();
  for (const i of items) by.set(i.kind, (by.get(i.kind) ?? 0) + 1);
  return [...by].map(([k, n]) => [KIND_WORD[k] ?? k, n] as [string, number]).sort((a, b) => b[1] - a[1]);
}
/** Какие кусочки отмечены при входе: «base», если он есть и годен, иначе первый годный. Сохранённый выбор берётся, пока его кусочки есть на машине. */
export function firstPick(pieces: Piece[], was: string[] = []): string[] {
  const ok = pieces.filter((p) => p.ok).map((p) => p.id);
  const kept = was.filter((id) => ok.includes(id));
  if (kept.length) return kept;
  return ok.includes("base") ? ["base"] : ok.slice(0, 1);
}

/** Мера индекса памяти: Claude читает из MEMORY.md первые 200 строк и 25 КБ — что сверх, в сессию не попадёт. */
export const MEMORY_LINES = 200, MEMORY_BYTES = 25 * 1024;
export function memoryMeasure(text: string): { lines: number; bytes: number; over: boolean; word: string } {
  const lines = text ? text.replace(/\n$/, "").split("\n").length : 0;
  const bytes = new TextEncoder().encode(text).length;
  const over = lines > MEMORY_LINES || bytes > MEMORY_BYTES;
  return { lines, bytes, over, word: `${lines} из ${MEMORY_LINES} строк · ${(bytes / 1024).toFixed(1).replace(".", ",")} из 25 КБ` };
}

/** Задача сессии, которая сводит остановившееся слияние клона. */
export const mergeTask = (c: Pick<RepoClone, "repo" | "files" | "op">) =>
  `В этой папке — клон репозитория кусочков ${c.repo}. Сведение с GitHub остановилось${c.op ? ` на шаге «${c.op}»` : ""}${c.files?.length ? `; конфликт в файлах: ${c.files.join(", ")}` : ""}. Разбери конфликт, сохрани смысл обеих сторон, заверши слияние и отправь результат (git push). В конце скажи одной строкой, что сделано.`;

/** Что стоит за репозиторием: его кусочки на машине и сессии флота, у которых они в документе. */
export function repoUse(repo: string, pieces: Piece[], sessions: SessionRow[]): { pieces: string[]; sessions: string[] } {
  const ids = pieces.filter((p) => p.repo === repo).map((p) => p.id);
  return { pieces: ids, sessions: sessions.filter((s) => s.spec.pieces?.some((p) => ids.includes(p))).map((s) => s.callsign) };
}

/** Вкладка просмотра для вида строки набора: по ней ведёт ссылка из «Итога». */
export const tabOfKind = (kind: string): string | undefined => VIEW_TABS.find(([, , kinds]) => kinds.includes(kind))?.[0] ?? (kind === "setting" ? "settings" : undefined);

type Layered = {
  prompt?: { agent?: { name: string; from: string; path: string }; style?: { name: string; from: string; path: string; found: boolean }; append?: string };
  files?: Record<string, Array<{ path: string; size: number }>>;
  items: Array<{ kind: string; name: string; piece: string; path?: string }>;
};
/** Слои промпта набора с размером: что и сколько добавляется к основе Claude Code. */
export function promptLayers(v: Layered): Array<{ layer: string; name: string; bytes?: number }> {
  const size = (piece: string, path?: string) => (path ? v.files?.[piece]?.find((f) => f.path === path)?.size : undefined);
  const out: Array<{ layer: string; name: string; bytes?: number }> = [{ layer: "основа", name: "Claude Code" }];
  if (v.prompt?.agent) out.push({ layer: "агент", name: v.prompt.agent.name, bytes: size(v.prompt.agent.from, v.prompt.agent.path) });
  if (v.prompt?.style) out.push({ layer: "стиль", name: v.prompt.style.name, bytes: size(v.prompt.style.from, v.prompt.style.path) });
  if (v.prompt?.append) out.push({ layer: "добавка", name: "к системному промпту", bytes: new TextEncoder().encode(v.prompt.append).length });
  for (const i of v.items.filter((x) => x.kind === "instructions")) out.push({ layer: "инструкции", name: i.name, bytes: size(i.piece, i.path) });
  for (const i of v.items.filter((x) => x.kind === "memory" && x.path && /(^|\/)MEMORY\.md$/.test(x.path))) out.push({ layer: "индекс памяти", name: i.piece, bytes: size(i.piece, i.path) });
  return out;
}

/** Тип записи памяти — названный, по первому слову описания или по имени файла; неизвестный — «прочее». */
export const memoryType = (i: { about?: string; path?: string; type?: string }): string =>
  i.type ?? /^(user|feedback|project|reference)\b/.exec(i.about ?? "")?.[1] ?? /(^|\/)(user|feedback|project|reference)[_\/-]/.exec(i.path ?? "")?.[2] ?? "прочее";
export const MEMORY_PAGE = 20;

/** Подходит ли строка набора под поиск: по имени и описанию. */
export const itemMatches = (i: { name: string; about?: string }, q: string) => !q.trim() || [i.name, i.about].some((x) => x?.toLowerCase().includes(q.trim().toLowerCase()));

/** Подходит ли кусочек под поиск: по имени, описанию и репозиторию. */
export const pieceMatches = (p: Piece, q: string) => !q.trim() || [p.id, p.title, p.about, p.repo].some((x) => x?.toLowerCase().includes(q.trim().toLowerCase()));

function Tree({ nodes }: { nodes: TreeNode[] }) {
  return <ul className="tree">{nodes.map((n) => <li key={n.id}><span className="mono">{n.id}</span>{n.set && <Text span size="xs" className="muted"> · набор</Text>}{n.children?.length ? <Tree nodes={n.children} /> : null}</li>)}</ul>;
}

/** Репозитории кусочков флота (настройка profiles.repos) и состояние их клонов на машине. */
function Repos({ machine, clones, pieces, onClose }: { machine: string | null; clones: RepoClone[]; pieces: Piece[]; onClose: () => void }) {
  const qc = useQueryClient();
  const sessions = useFleet((f) => f.sessions);
  const admin = useFleet((f) => !!f.you?.admin);
  const prefs = useCall(prefsGet, { scope: "fleet", prefix: "profiles.repos" });
  const [add, setAdd] = useState("");
  const list = (prefs.data?.values["profiles.repos"] as string[] | undefined) ?? [];
  const save = async (next: string[]) => (await act(prefsSet, { scope: "fleet", name: "profiles.repos", value: next }, "Список сохранён, машины сведут клоны")) && qc.invalidateQueries({ queryKey: ["prefs.get"] });
  const valid = /^[\w.-]+\/[\w.-]+$/.test(add.trim()) && !list.includes(add.trim());
  return (
    <Stack gap="xs">
      {list.map((repo) => {
        const c = clones.find((x) => x.repo === repo);
        const use = repoUse(repo, pieces, Object.values(sessions));
        return (
          <div key={repo} className="line">
            <div className="grow">
              <Text size="sm" className="mono trunc">{repo}</Text>
              <Text size="xs">{count(use.pieces.length, "кусочек", "кусочка", "кусочков")} · {nSessions(use.sessions.length)}</Text>
              {machine && <Text size="xs" c={c?.state === "error" || c?.state === "conflict" ? "red" : undefined} className={c?.state === "ok" || !c ? "muted" : undefined}>{machine}: {c ? `${CLONE_WORD[c.state]}${c.op ? ` · ${c.op}` : ""}${c.error ? ` · ${c.error}` : ""}${c.at ? ` · ${ago(c.at)}` : ""}` : "клона нет"}</Text>}
              {c?.files?.length ? <Text size="xs" className="mono muted" style={{ overflowWrap: "anywhere" }}>{c.files.join(", ")}</Text> : null}
            </div>
            {admin && <ActionIcon variant="subtle" color="red" aria-label={`Убрать репозиторий ${repo}`} onClick={() => confirmDanger({
              title: `Убрать репозиторий ${repo}?`, confirm: "Убрать",
              body: use.sessions.length ? <>Кусочки из него потеряют сессии: <span className="mono">{use.sessions.join(", ")}</span>. Со следующего запуска они пойдут без этих кусочков.</> : "Машины уберут его клон; сессий с его кусочками нет.",
              onConfirm: () => save(list.filter((x) => x !== repo)),
            })}><IconTrash size={15} /></ActionIcon>}
          </div>
        );
      })}
      {!list.length && <Text size="sm" className="muted">Репозиториев нет</Text>}
      {admin && (
        <Group align="end" gap="xs">
          <TextInput label="Добавить репозиторий" placeholder="team/profiles" className="mono" value={add} onChange={(e) => setAdd(e.currentTarget.value)} style={{ flex: 1 }} onKeyDown={(e) => e.key === "Enter" && valid && (void save([...list, add.trim()]), setAdd(""))} />
          <Button disabled={!valid} onClick={() => (void save([...list, add.trim()]), setAdd(""))}>Добавить</Button>
        </Group>
      )}
      <Button variant="default" w="fit-content" onClick={onClose}>Готово</Button>
    </Stack>
  );
}

function FileView({ machine, piece, path, onClose }: { machine: string; piece: string; path: string; onClose: () => void }) {
  const f = useCall(profileFile, { to: "@" + machine, piece, path });
  return (
    <Page opened onClose={onClose} title={<span className="mono">{piece}/{path}</span>} name="file" wide>
      {f.isLoading ? <Loader size="sm" /> : f.error ? <Failed error={f.error} retry={f.refetch} /> : <pre className="codebox" style={{ maxHeight: "60vh", overflow: "auto" }}>{f.data?.text}</pre>}
    </Page>
  );
}

function Items({ items, open }: { items: Item[]; open: (i: Item) => void }) {
  if (!items.length) return <Text size="sm" className="muted">В наборе этого нет</Text>;
  return (
    <div>
      {items.map((i, n) => (
        <div key={n} className="line">
          <div className="grow">
            {i.path ? <button type="button" className="linkbtn mono" onClick={() => open(i)}>{i.name}</button> : <span className="mono">{i.name}</span>}
            {i.about && <Text size="sm" style={{ overflowWrap: "anywhere" }}>{i.about}</Text>}
          </div>
          <Text size="xs" className="mono muted">{i.piece}</Text>
        </div>
      ))}
    </div>
  );
}

/** Мера индекса памяти набора: читает MEMORY.md кусочка и говорит, сколько из него попадёт в сессию. */
function MemoryMeasure({ machine, piece, path }: { machine: string; piece: string; path: string }) {
  const f = useCall(profileFile, { to: "@" + machine, piece, path });
  if (!f.data) return null;
  const m = memoryMeasure(f.data.text);
  return <Text size="sm" c={m.over ? "orange" : undefined}><span className="mono">{piece}/{path}</span>: {m.word}{m.over ? " — что сверх, в сессию не попадёт" : ""}</Text>;
}

function Viewer({ machine, picked, v, q }: { machine: string; picked: string[]; v: View; q: string }) {
  const [tab, setTab] = useState("sum");
  const [file, setFile] = useState<{ piece: string; path: string } | null>(null);
  const [memType, setMemType] = useState("");
  const [memMore, setMemMore] = useState(MEMORY_PAGE);
  const kinds = VIEW_TABS.find(([id]) => id === tab)![2];
  const open = (i: { piece: string; path?: string }) => i.path && setFile({ piece: i.piece, path: i.path });
  const p = v.prompt;
  return (
    <div className="card" style={{ minWidth: 0 }}>
      <div className="subtabs" role="tablist" aria-label="Что в наборе">
        {VIEW_TABS.map(([id, word]) => <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>{word}</button>)}
      </div>
      {tab === "sum" && (
        <Stack gap="sm">
          <Group gap={6}>{[...new Set(v.items.map((i) => i.kind))].map((kind) => {
            const to = tabOfKind(kind), n = v.items.filter((i) => i.kind === kind).length;
            return to ? <Button key={kind} size="compact-xs" variant="default" onClick={() => setTab(to)}>{KIND_WORD[kind] ?? kind}: {n}</Button> : <Badge key={kind} variant="default">{KIND_WORD[kind] ?? kind}: {n}</Badge>;
          })}{!v.items.length && <Text size="sm" className="muted">Набор пуст</Text>}</Group>
          {(v.tree as TreeNode[] | undefined)?.length ? <Tree nodes={v.tree as TreeNode[]} /> : <Text size="sm" className="mono">{picked.join(" + ")}</Text>}
          {v.other?.length ? <Text size="sm" c="orange">Не подключится: {nFiles(v.other.length)} — на вкладке «Файлы»</Text> : null}
        </Stack>
      )}
      {tab === "prompt" && (
        <Stack gap="xs">
          <dl className="kv" style={{ gridTemplateColumns: "auto minmax(0,1fr)" }}>
            <dt>Агент</dt><dd>{p?.agent ? <button type="button" className="linkbtn mono" onClick={() => open({ piece: p.agent!.from, path: p.agent!.path })}>{p.agent.name}</button> : "обычный"}{p?.agent && <span className="muted"> · {p.agent.from}</span>}</dd>
            <dt>Стиль</dt><dd>{p?.style ? <>{p.style.found ? <button type="button" className="linkbtn mono" onClick={() => open({ piece: p.style!.from, path: p.style!.path })}>{p.style.name}</button> : <span className="lost mono">{p.style.name}</span>}<span className="muted"> · {p.style.from}{p.style.found ? "" : " · файл стиля не найден"}</span></> : "обычный"}</dd>
          </dl>
          <div aria-label="Слои промпта">{promptLayers(v as Layered).map((l, i) => <div key={i} className="line"><Text size="sm" w={110}>{l.layer}</Text><Text size="sm" className="mono grow trunc">{l.name}</Text>{l.bytes !== undefined && <Text size="xs" className="muted">{bytesWord(l.bytes)}</Text>}</div>)}</div>
          {p?.append ? <><Text size="sm" fw={600}>Добавка к промпту</Text><pre className="codebox">{p.append}</pre></> : <Text size="sm" className="muted">Добавки к промпту нет</Text>}
        </Stack>
      )}
      {tab === "memory" && v.items.filter((i) => i.kind === "memory" && i.path && /(^|\/)MEMORY\.md$/.test(i.path)).map((i) => <MemoryMeasure key={i.piece + i.path} machine={machine} piece={i.piece} path={i.path!} />)}
      {tab === "memory" && (() => {
        const all = v.items.filter((i) => i.kind === "memory" && itemMatches(i, q));
        const types = [...new Set(all.map(memoryType))];
        const shown = all.filter((i) => !memType || memoryType(i) === memType);
        return (
          <Stack gap="xs" mt="xs">
            {types.length > 1 && <Chip.Group value={memType} onChange={(t) => (setMemType(t as string), setMemMore(MEMORY_PAGE))}><Group gap={6}><Chip size="xs" value="">все</Chip>{types.map((t) => <Chip key={t} size="xs" value={t}>{t}</Chip>)}</Group></Chip.Group>}
            <Items items={shown.slice(0, memMore)} open={open} />
            {shown.length > memMore && <Button size="compact-xs" variant="default" w="fit-content" onClick={() => setMemMore(memMore + MEMORY_PAGE)}>ещё {Math.min(MEMORY_PAGE, shown.length - memMore)}</Button>}
          </Stack>
        );
      })()}
      {tab !== "memory" && kinds.length > 0 && <Items items={v.items.filter((i) => kinds.includes(i.kind) && itemMatches(i, q))} open={open} />}
      {tab === "settings" && (
        <div>
          {Object.entries(v.settings ?? {}).map(([name, w]) => (
            <div key={name} className="line" style={{ alignItems: "start" }}>
              <div className="grow">
                <Text size="sm" className="mono">{name}</Text>
                <Text size="sm" className="mono" style={{ overflowWrap: "anywhere" }}>{JSON.stringify(w.value)} <span className="muted">· {w.from}</span></Text>
                {/* проигравшие значения: что было бы без кусочка-победителя */}
                {w.lost.map((l, i) => <Text key={i} size="xs" className="mono lost" style={{ overflowWrap: "anywhere" }}>{JSON.stringify(l.value)} · {l.from}</Text>)}
              </div>
            </div>
          ))}
          {!Object.keys(v.settings ?? {}).length && <Text size="sm" className="muted">Настроек в наборе нет</Text>}
        </div>
      )}
      {tab === "files" && (
        <Stack gap="sm">
          {Object.entries(v.files ?? {}).map(([piece, files]) => (
            <div key={piece}>
              <Text size="sm" fw={600} className="mono">{piece}</Text>
              {files.map((f) => {
                const lost = v.other?.some((o) => o.from === piece && o.path === f.path);
                return <div key={f.path} className="line"><button type="button" className={`linkbtn mono grow${lost ? " lost" : ""}`} style={{ textAlign: "left", overflowWrap: "anywhere" }} onClick={() => open({ piece, path: f.path })}>{f.path}</button>{lost && <Text size="xs" c="orange">не подключится</Text>}<Text size="xs" className="muted">{bytesWord(f.size)}</Text></div>;
              })}
            </div>
          ))}
          {!Object.keys(v.files ?? {}).length && <Text size="sm" className="muted">Файлов нет</Text>}
        </Stack>
      )}
      {file && <FileView machine={machine} piece={file.piece} path={file.path} onClose={() => setFile(null)} />}
    </div>
  );
}

export function Profiles() {
  const qc = useQueryClient();
  const machines = useFleet((f) => f.machines);
  const online = Object.values(machines).filter((m) => m.online).map((m) => m.name);
  const go = useNavigate();
  const wide = useWide();
  const [machine, setMachine] = useState<string | null>(online[0] ?? null);
  // выбор появляется, когда пришёл список: набор из несуществующих кусочков Host не соберёт
  // выбранные кусочки помнит устройство: следующий заход открывает тот же набор
  const [kept, setKept] = useLocal<string[]>("profiles.pick", []);
  const [picked, setPickedRaw] = useState<string[] | null>(null);
  const setPicked = (f: (x: string[] | null) => string[]) => setPickedRaw((x) => { const next = f(x); setKept(next); return next; });
  const sessions = useFleet((f) => f.sessions);
  /** на узком экране список и просмотр — поочерёдно */
  const [viewing, setViewing] = useState(false);
  const [q, setQ] = useState("");
  const [repos, setRepos] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const list = useCall(profileList, machine ? { to: "@" + machine } : null);
  useEffect(() => { if (list.data) setPickedRaw((was) => firstPick(list.data!.pieces, was ?? kept)); }, [list.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const chosen = picked ?? [];
  const view = useCall(profileView, machine && chosen.length ? { to: "@" + machine, pieces: chosen } : null);
  if (list.error) return <Failed error={list.error} retry={list.refetch} />;
  // поиск идёт и по кусочкам, и по тому, что внутри набора: кусочек остаётся в списке, если в его наборе нашлось слово
  const inside = new Set((view.data?.items ?? []).filter((i) => q.trim() && itemMatches(i, q)).map((i) => i.piece));
  const pieces = (list.data?.pieces ?? []).filter((p) => pieceMatches(p, q) || inside.has(p.id));
  /** Слияние клона остановилось на конфликте: открыть сессию в клоне с задачей свести. */
  const mergeIn = async (c: RepoClone) => {
    if (!machine || !c.dir) return;
    const r = await act(sessionOpen, { to: "@" + machine, spec: { name: "merge-" + c.repo.split("/").pop()!.toLowerCase().replace(/[^a-z0-9_-]/g, "-"), cwd: c.dir }, prompt: mergeTask(c) });
    if (r) go(`/work/${r.callsign}`);
  };
  const clones = list.data?.repos ?? [];
  const bad = clones.filter((c) => c.state === "error" || c.state === "conflict");
  /** Свести клоны с GitHub сейчас: на одной машине или на всех машинах на связи. */
  const sync = async (targets: string[]) => {
    setSyncing(true);
    const results = await Promise.allSettled(targets.map((m) => api.call(profileSync, { to: "@" + m })));
    setSyncing(false);
    const failed = results.flatMap((r, i) => (r.status === "rejected" ? [`${targets[i]}: ${sayError(r.reason)}`] : r.value.repos.filter((c) => c.state === "error" || c.state === "conflict").map((c) => `${targets[i]}: ${c.repo} — ${CLONE_WORD[c.state]}${c.error ? `, ${c.error}` : ""}`)));
    notifications.show(failed.length ? { title: "Свелось не всё", message: failed.join("; "), color: "red", autoClose: 9000 } : { message: targets.length > 1 ? "Клоны сведены на всех машинах" : `Клоны сведены на ${targets[0]}`, color: "teal" });
    await qc.invalidateQueries({ queryKey: ["profile.list"] });
    await qc.invalidateQueries({ queryKey: ["profile.view"] });
  };
  /** Свести клоны везде и перечитать инструменты у живых сессий: новые скилы и агенты доходят без перезапуска. */
  const reread = async () => {
    await sync(online);
    const live = Object.values(sessions).filter((s) => (s.state === "idle" || s.state === "busy" || s.state === "waiting") && machines[s.callsign.slice(s.callsign.indexOf("@") + 1)]?.online);
    const done = await Promise.allSettled(live.map((s) => api.call(sessionCall, { to: s.callsign, method: "reload" })));
    const ok = done.filter((r) => r.status === "fulfilled").length;
    notifications.show({ message: `Перечитано сессий: ${ok} из ${live.length}`, color: ok === live.length ? "teal" : "orange" });
  };
  return (
    <Stack>
      <Group gap="xs" align="end">
        <Select size="xs" w={200} aria-label="Машина" data={online} value={machine} onChange={setMachine} className="mono" allowDeselect={false} />
        <TextInput size="xs" w={220} leftSection={<IconSearch size={14} />} placeholder="Кусочек" aria-label="Поиск кусочка" value={q} onChange={(e) => setQ(e.currentTarget.value)} />
        <Button size="xs" variant="default" onClick={() => setRepos(true)}>Репозитории</Button>
        <Button size="xs" variant="default" loading={syncing} disabled={!machine} onClick={() => machine && void sync([machine])}>Свести сейчас</Button>
        {online.length > 1 && <Button size="xs" variant="subtle" loading={syncing} onClick={() => void sync(online)}>Свести везде</Button>}
        <Button size="xs" variant="subtle" loading={syncing} onClick={() => void reread()}>Перечитать сессии</Button>
      </Group>
      {bad.length > 0 && <div className="ban bad">{bad.map((c) => <Group key={c.repo} gap="sm" wrap="wrap"><Text size="sm" style={{ minWidth: 0, overflowWrap: "anywhere" }}><span className="mono">{c.repo}</span>: {CLONE_WORD[c.state]}{c.op ? ` · ${c.op}` : ""}{c.error ? ` · ${c.error}` : ""}</Text>{c.state === "conflict" && c.dir && <Button size="compact-xs" variant="default" onClick={() => void mergeIn(c)}>Свести в сессии</Button>}</Group>)}</div>}
      {!wide && viewing && <Button size="xs" variant="subtle" w="fit-content" leftSection={<IconArrowLeft size={14} />} onClick={() => setViewing(false)}>К списку</Button>}
      <div className="split">
        {(wide || !viewing) && <Stack gap="xs">
          {pieces.map((p) => (
            <div key={p.id} className={`card${p.ok ? "" : " off"}`} style={{ padding: 10 }}>
              <Checkbox label={<Group gap={6}><Text fw={600}>{p.title ?? p.id}</Text>{(p.has?.piece ?? p.has?.pieces ?? 0) > 0 && <Badge size="xs" variant="default">набор</Badge>}{(p.has?.style ?? p.has?.styles ?? 0) > 0 && <Badge size="xs" variant="default">стиль</Badge>}</Group>} disabled={!p.ok} checked={chosen.includes(p.id)} onChange={(e) => { const on = e.currentTarget.checked; setPicked((x) => (on ? [...(x ?? []), p.id] : (x ?? []).filter((y) => y !== p.id))); }} />
              {p.about && <Text size="sm">{p.about}</Text>}
              {!p.ok && <Text size="sm" c="red">{p.why}</Text>}
              <Text size="xs" className="mono muted trunc">{p.id} · {p.repo}{p.rev ? ` @ ${p.rev}` : ""}</Text>
            </div>
          ))}
          {list.data && !pieces.length && <Text size="sm" className="muted">{q ? `Ничего не нашлось по «${q}»` : "Кусочков нет: добавьте репозиторий"}</Text>}
          {!wide && chosen.length > 0 && <Button size="xs" w="fit-content" onClick={() => setViewing(true)}>Что в наборе</Button>}
        </Stack>}
        {(wide || viewing) && (machine && view.data ? <Viewer machine={machine} picked={chosen} v={view.data} q={q} /> : view.error ? <Failed error={view.error} retry={view.refetch} /> : <div className="card"><Text size="sm" className="muted">{chosen.length ? "Собираю набор…" : list.data?.pieces.length ? "Отметьте кусочки слева" : "Кусочков на машине нет"}</Text></div>)}
      </div>
      <Page name="repos" opened={repos} onClose={() => setRepos(false)} title="Репозитории кусочков"><Repos machine={machine} clones={clones} pieces={list.data?.pieces ?? []} onClose={() => setRepos(false)} /></Page>
    </Stack>
  );
}
