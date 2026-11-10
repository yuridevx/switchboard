// «Флот → Профили»: кусочки на машине, репозитории и их клоны, сведение, просмотр набора по вкладкам.
import { prefsGet, prefsSet, profileFile, profileList, profileSync, profileView, type OutputOf, type Piece, type RepoClone } from "@sb/protocol";
import { ActionIcon, Badge, Button, Checkbox, Group, Loader, Modal, Select, Stack, Text, TextInput } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconSearch, IconTrash } from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { act, api, sayError } from "../../api.ts";
import { Failed, useCall } from "../../common.tsx";
import { ago, bytesWord, nFiles } from "../../lib/time.ts";
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
/** Подходит ли кусочек под поиск: по имени, описанию и репозиторию. */
export const pieceMatches = (p: Piece, q: string) => !q.trim() || [p.id, p.title, p.about, p.repo].some((x) => x?.toLowerCase().includes(q.trim().toLowerCase()));

function Tree({ nodes }: { nodes: TreeNode[] }) {
  return <ul className="tree">{nodes.map((n) => <li key={n.id}><span className="mono">{n.id}</span>{n.set && <Text span size="xs" className="muted"> · набор</Text>}{n.children?.length ? <Tree nodes={n.children} /> : null}</li>)}</ul>;
}

/** Репозитории кусочков флота (настройка profiles.repos) и состояние их клонов на машине. */
function Repos({ machine, clones, onClose }: { machine: string | null; clones: RepoClone[]; onClose: () => void }) {
  const qc = useQueryClient();
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
        return (
          <div key={repo} className="line">
            <div className="grow">
              <Text size="sm" className="mono trunc">{repo}</Text>
              {machine && <Text size="xs" c={c?.state === "error" || c?.state === "conflict" ? "red" : undefined} className={c?.state === "ok" || !c ? "muted" : undefined}>{machine}: {c ? `${CLONE_WORD[c.state]}${c.op ? ` · ${c.op}` : ""}${c.error ? ` · ${c.error}` : ""}${c.at ? ` · ${ago(c.at)}` : ""}` : "клона нет"}</Text>}
              {c?.files?.length ? <Text size="xs" className="mono muted" style={{ overflowWrap: "anywhere" }}>{c.files.join(", ")}</Text> : null}
            </div>
            {admin && <ActionIcon variant="subtle" color="red" aria-label={`Убрать репозиторий ${repo}`} onClick={() => void save(list.filter((x) => x !== repo))}><IconTrash size={15} /></ActionIcon>}
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
    <Modal opened onClose={onClose} title={<span className="mono">{piece}/{path}</span>} size="lg">
      {f.isLoading ? <Loader size="sm" /> : f.error ? <Failed error={f.error} retry={f.refetch} /> : <pre className="codebox" style={{ maxHeight: "60vh", overflow: "auto" }}>{f.data?.text}</pre>}
    </Modal>
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

function Viewer({ machine, picked, v }: { machine: string; picked: string[]; v: View }) {
  const [tab, setTab] = useState("sum");
  const [file, setFile] = useState<{ piece: string; path: string } | null>(null);
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
          <Group gap={6}>{summary(v.items).map(([k, n]) => <Badge key={k} variant="default">{k}: {n}</Badge>)}{!v.items.length && <Text size="sm" className="muted">Набор пуст</Text>}</Group>
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
          {p?.append ? <><Text size="sm" fw={600}>Добавка к промпту</Text><pre className="codebox">{p.append}</pre></> : <Text size="sm" className="muted">Добавки к промпту нет</Text>}
        </Stack>
      )}
      {kinds.length > 0 && <Items items={v.items.filter((i) => kinds.includes(i.kind))} open={open} />}
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
  const [machine, setMachine] = useState<string | null>(online[0] ?? null);
  const [picked, setPicked] = useState<string[]>(["base"]);
  const [q, setQ] = useState("");
  const [repos, setRepos] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const list = useCall(profileList, machine ? { to: "@" + machine } : null);
  const view = useCall(profileView, machine && picked.length ? { to: "@" + machine, pieces: picked } : null);
  if (list.error) return <Failed error={list.error} retry={list.refetch} />;
  const pieces = (list.data?.pieces ?? []).filter((p) => pieceMatches(p, q));
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
  return (
    <Stack>
      <Group gap="xs" align="end">
        <Select size="xs" w={200} aria-label="Машина" data={online} value={machine} onChange={setMachine} className="mono" allowDeselect={false} />
        <TextInput size="xs" w={220} leftSection={<IconSearch size={14} />} placeholder="Кусочек" aria-label="Поиск кусочка" value={q} onChange={(e) => setQ(e.currentTarget.value)} />
        <Button size="xs" variant="default" onClick={() => setRepos(true)}>Репозитории</Button>
        <Button size="xs" variant="default" loading={syncing} disabled={!machine} onClick={() => machine && void sync([machine])}>Свести сейчас</Button>
        {online.length > 1 && <Button size="xs" variant="subtle" loading={syncing} onClick={() => void sync(online)}>Свести везде</Button>}
      </Group>
      {bad.length > 0 && <div className="ban bad">{bad.map((c) => <Text key={c.repo} size="sm"><span className="mono">{c.repo}</span>: {CLONE_WORD[c.state]}{c.op ? ` · ${c.op}` : ""}{c.error ? ` · ${c.error}` : ""}</Text>)}</div>}
      <div className="split">
        <Stack gap="xs">
          {pieces.map((p) => (
            <div key={p.id} className={`card${p.ok ? "" : " off"}`} style={{ padding: 10 }}>
              <Checkbox label={<Text fw={600}>{p.title ?? p.id}</Text>} disabled={!p.ok} checked={picked.includes(p.id)} onChange={(e) => setPicked((x) => (e.currentTarget.checked ? [...x, p.id] : x.filter((y) => y !== p.id)))} />
              {p.about && <Text size="sm">{p.about}</Text>}
              {!p.ok && <Text size="sm" c="red">{p.why}</Text>}
              <Text size="xs" className="mono muted trunc">{p.id} · {p.repo}{p.rev ? ` @ ${p.rev}` : ""}</Text>
            </div>
          ))}
          {list.data && !pieces.length && <Text size="sm" className="muted">{q ? `Ничего не нашлось по «${q}»` : "Кусочков нет: добавьте репозиторий"}</Text>}
        </Stack>
        {machine && view.data ? <Viewer machine={machine} picked={picked} v={view.data} /> : view.error ? <Failed error={view.error} retry={view.refetch} /> : <div className="card"><Text size="sm" className="muted">{picked.length ? "Собираю набор…" : "Отметьте кусочки слева"}</Text></div>}
      </div>
      <Modal opened={repos} onClose={() => setRepos(false)} title="Репозитории кусочков"><Repos machine={machine} clones={clones} onClose={() => setRepos(false)} /></Modal>
    </Stack>
  );
}
