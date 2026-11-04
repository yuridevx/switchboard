// Модуль profiles: профиль сессии — папка в git-репозитории: CLAUDE.md (добавка к промпту), profile.yaml (модель и усилие),
// memory/ (память, пишет только claude) и skills/ (скилы профиля). У каждого профиля свой путь памяти — settings.autoMemoryDirectory;
// папка профиля — локальный плагин SDK, скилы в сессии — «<папка>:<скил>».
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { refuse } from "@switchboard/host";
import type { Host, Module, QueryPart, Session } from "@switchboard/host";
import { parseYaml, splitId } from "./folder.ts";
import { makeSync, realGit, syncedDirs } from "./sync.ts";
import type { Git, RepoState } from "./sync.ts";

export type { Git, RepoState };

type Mine = { profile: string | null };
type Config = { repos?: string[] };

/** Синхронизация раз в минуту. */
const SYNC_MS = 60_000;
const NO_FOLDER = "в клонах нет папки профиля с CLAUDE.md или profile.yaml";

const isInside = (dir: string, path: string) => {
  const rel = relative(resolve(dir), resolve(path));
  return !!rel && !rel.startsWith("..") && !rel.startsWith(sep) && !/^[A-Za-z]:/.test(rel);
};
const yamlIn = (dir: string) => (existsSync(join(dir, "profile.yaml")) ? parseYaml(readFileSync(join(dir, "profile.yaml"), "utf8")) : {});

export function make(deps: { git?: Git } = {}): Module {
  let host: Host;
  let timer: ReturnType<typeof setInterval> | null = null;
  const repos = (): string[] => host.config<Config>().repos ?? [];
  const syncing = makeSync(() => host, deps.git ?? realGit);
  const profileOf = (s: Session) => s.store<Mine>().get()?.profile ?? null;

  /** Папка профиля, если она есть в клоне. */
  function folderOf(id: string): string | null {
    const p = splitId(id);
    if (!p) return null;
    const dir = join(syncing.cloneDir(p.repo), ...p.folder.split("/"));
    return existsSync(join(dir, "CLAUDE.md")) || existsSync(join(dir, "profile.yaml")) ? dir : null;
  }

  /** Задание модели, пока состояние репозитория профиля не ok. */
  function taskFor(id: string): string | null {
    const p = splitId(id);
    if (!p) return null;
    const st = syncing.stateOf(p.repo);
    const where = `клон ${syncing.cloneDir(p.repo)}`;
    if (!folderOf(id)) return `Профиля ${id} нет в клоне (${where}). Без человека не решить — спроси.`;
    if (st.state === "conflict") return `Память профиля ${p.folder} не сведена: ${st.op} — конфликт в ${(st.files ?? []).join(", ")} (${where}). Сведи обе версии, закоммить и отправь. Без человека не решить — спроси.`;
    if (st.state === "error") return `Память профиля ${p.folder} не отправлена: ${st.op} — ${st.error} (${where}). Без человека не решить — спроси.`;
    return null;
  }

  /** Хук PostToolUse: запись в memory/ или skills/ профиля — синхронизация в очередь, ответ сразу. */
  const onWrite = (id: string) => async (input: unknown) => {
    const path = (input as { tool_input?: { file_path?: string } })?.tool_input?.file_path ?? "";
    const dir = folderOf(id);
    const p = splitId(id);
    if (dir && p && path && syncedDirs().some((sub) => isInside(join(dir, sub), path))) void syncing.sync(p.repo);
    return {};
  };

  /** Хуки SessionStart и UserPromptSubmit: состояние не ok — задание модели. */
  const nudge = (id: string, event: "SessionStart" | "UserPromptSubmit") => async () => {
    const task = taskFor(id);
    return task ? { hookSpecificOutput: { hookEventName: event, additionalContext: task } } : {};
  };

  function sessionPart(s: Session): QueryPart | undefined {
    const id = profileOf(s);
    if (!id) return undefined;
    const dir = folderOf(id);
    if (!dir) {
      host.log({ kind: "stop", ev: "profile", word: "no_profile", callsign: s.info.callsign, why: `${id}: профиля нет в клоне — сессия без его части` });
      return undefined;
    }
    const y = yamlIn(dir);
    const memory = join(dir, "memory");
    mkdirSync(memory, { recursive: true });
    const md = join(dir, "CLAUDE.md");
    return {
      ...(existsSync(md) ? { append: readFileSync(md, "utf8") } : {}),
      settings: {
        ...(y.model ? { model: y.model } : {}),
        ...(y.effort ? { effortLevel: y.effort } : {}),
        ...(y.max_effort ? { maxEffortLevel: y.max_effort } : {}),
        ...(y.fallback_model ? { fallbackModel: [y.fallback_model].flat() } : {}),
        autoMemoryDirectory: memory,
      },
      // папка профиля — плагин: скилы из skills/; хуки профиля в проекте видят, что профиль ведёт Switchboard
      plugins: [{ type: "local", path: dir }],
      env: { SWITCHBOARD_PROFILE: id },
      hooks: {
        PostToolUse: [{ matcher: "Write|Edit|MultiEdit", hooks: [onWrite(id)] }],
        SessionStart: [{ hooks: [nudge(id, "SessionStart")] }],
        UserPromptSubmit: [{ hooks: [nudge(id, "UserPromptSubmit")] }],
      },
    };
  }

  return {
    requests: {
      "session.profile"(f, ctx) {
        const s = ctx.host.session(String(f.callsign ?? ""))!;
        const id = f.profile === null || f.profile === undefined ? null : String(f.profile);
        if (id !== null && !folderOf(id)) throw refuse("no_profile", `${id}: ${NO_FOLDER}`);
        const was = profileOf(s);
        s.store<Mine>().set({ profile: id });
        // живой сессии — close() и resume между ходами
        if (was === id || s.state === "stopped" || s.state === "failed") return { restart: false };
        void s.restart();
        return { restart: true };
      },
      async "machine.profiles"(f) {
        if (f.sync === true) await Promise.all(repos().map((r) => syncing.sync(r)));
        const profiles: Record<string, unknown> = {};
        const states: Record<string, RepoState> = {};
        for (const repo of repos()) {
          states[repo] = syncing.stateOf(repo);
          for (const name of syncing.profilesOf(repo)) {
            const y = yamlIn(join(syncing.cloneDir(repo), name));
            profiles[`${repo}/${name}`] = { model: y.model ?? null, effort: y.effort ?? null, ...(typeof y.about === "string" && y.about ? { about: y.about } : {}) };
          }
        }
        return { profiles, repos: states };
      },
    },
    fields: {
      profile(s) {
        const id = profileOf(s);
        if (!id) return undefined;
        const p = splitId(id);
        return { id, state: !p || !folderOf(id) ? "error" : syncing.stateOf(p.repo).state };
      },
    },
    // профиль новой сессии — из запроса открытия; при следующих запусках запроса нет, берётся сохранённый
    opening(s, req) {
      if (req.profile === undefined || req.profile === null) return;
      const id = String(req.profile);
      if (!folderOf(id)) throw refuse("no_profile", `${s.info.callsign}: ${id}: ${NO_FOLDER}`);
      s.store<Mine>().set({ profile: id });
    },
    openingReads: ["profile"],
    session: sessionPart,
    start(h) {
      host = h;
      syncing.begin();
      timer = setInterval(() => {
        for (const r of repos()) void syncing.sync(r);
      }, SYNC_MS);
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = null;
      await syncing.stop();
    },
  };
}
