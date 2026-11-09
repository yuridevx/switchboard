// Заголовки к Meta — как у Muse CLI, в его порядке (museclaude: muse 1.4.14). /muse-code/search Meta пускает только с user-agent muse-.
// Версия Muse — одним запросом к публичному каналу muse-stable; хэша сборки в канале нет, часть «; build …» тогда не пишется — Meta её не требует.
import { randomBytes } from "node:crypto";
import { arch, platform } from "node:os";

export const CHANNEL_URL = "https://api.meta.ai/muse-code/channels/muse-stable";
/** Свой user-agent лаунчера Muse для этого запроса. */
const LAUNCHER_UA = "muse-code/launcher-ps-3";
const RELEASE = /^(\d+\.\d+\.\d+)-R\d+(\.\d+)?$/;

/** Версия Muse CLI из канала: «1.4.14-R7309.1» → «1.4.14». Ответ не тот — отказ словами. */
export async function museVersion(signal: AbortSignal): Promise<string> {
  const res = await fetch(CHANNEL_URL, { headers: { "user-agent": LAUNCHER_UA }, signal });
  if (!res.ok) throw new Error(`канал muse-stable ответил ${res.status}`);
  const j = (await res.json()) as { channel?: string; version?: string };
  const m = j.channel === "muse-stable" ? RELEASE.exec(j.version ?? "") : null;
  if (!m) throw new Error(`канал muse-stable: не тот ответ ${JSON.stringify(j).slice(0, 200)}`);
  return m[1]!;
}

/** Как в Rust std::env::consts: windows-x86_64. */
function rustPlatform(): string {
  const os = ({ win32: "windows", darwin: "macos" } as Record<string, string>)[platform()] ?? platform();
  const cpu = ({ x64: "x86_64", arm64: "aarch64", ia32: "x86" } as Record<string, string>)[arch()] ?? arch();
  return `${os}-${cpu}`;
}

export const museUserAgent = (version: string) => `muse-build/${version} (non-interactive; ${rustPlatform()})`;

/** UUIDv7, как id сессий у CLI. */
function uuidv7(): string {
  const b = randomBytes(16);
  const ms = BigInt(Date.now());
  for (let i = 0; i < 6; i++) b[i] = Number((ms >> BigInt(8 * (5 - i))) & 0xffn);
  b[6] = (b[6]! & 0x0f) | 0x70;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const isUuid = (s: unknown): s is string => typeof s === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

/** POST /v1/responses: разговор Claude Code — одна сессия CLI. */
export function responsesHeaders(apiKey: string, version: string, sessionId: string | null): Record<string, string> {
  const session = isUuid(sessionId) ? sessionId.toLowerCase() : uuidv7();
  const span = randomBytes(8).toString("hex");
  return {
    authorization: `Bearer ${apiKey}`,
    "x-client-id": "tbh:exec",
    "x-tbh-session-id": session,
    "x-meta-ai-gateway-session-id": session,
    "x-tbh-thread-id": session,
    "x-tbh-root-session-id": session,
    "x-tbh-agent-role": "main",
    traceparent: `00-${session.replace(/-/g, "")}-${span}-01`,
    accept: "text/event-stream",
    "content-type": "application/json",
    "user-agent": museUserAgent(version),
  };
}

/** Прочие пути api.meta.ai: поиск. */
export const apiHeaders = (apiKey: string, version: string, extra: Record<string, string> = {}): Record<string, string> => ({
  authorization: `Bearer ${apiKey}`,
  "x-client-id": "tbh:exec",
  accept: "*/*",
  "user-agent": museUserAgent(version),
  ...extra,
});
