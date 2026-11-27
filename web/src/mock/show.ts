// Мок файлов флота: хранилище по хэшу и ходы с файлами — человек загрузил, сессия отправила, сессия подняла сайт.
// Файлы — настоящие: график и отчёт написала модель в опыте дизайна. Сайт мока лежит статикой страницы в public/s/.
import { SEND_TOOL, SITE_TOOL } from "@sb/protocol";
import shot from "./show/header-390.png?inline";
import latency from "./show/latency.svg?raw";
import { done, type Ev, got, reply, say, text, uid, use } from "./convo.ts";

const fromData = (url: string, type: string) => new Blob([Uint8Array.from(atob(url.slice(url.indexOf(",") + 1)), (c) => c.charCodeAt(0))], { type });
const H = { chart: "7c1e0a52b3d94f687c1e0a52b3d94f687c1e0a52b3d94f687c1e0a52b3d94f68", shot: "19d2e86fa07b4c3519d2e86fa07b4c3519d2e86fa07b4c3519d2e86fa07b4c35", zip: "b40f93d17a2c5e06b40f93d17a2c5e06b40f93d17a2c5e06b40f93d17a2c5e06", spec: "5ad07e31c96f48b25ad07e31c96f48b25ad07e31c96f48b25ad07e31c96f48b2", gone: "e5a1c07d92b34f18e5a1c07d92b34f18e5a1c07d92b34f18e5a1c07d92b34f18" };
/** Хранилище: хэш → содержимое. Загрузка со страницы кладёт сюда же. */
export const BLOBS = new Map<string, Blob>([
  [H.chart, new Blob([latency], { type: "image/svg+xml" })],
  [H.shot, fromData(shot, "image/png")],
  [H.zip, new Blob([new Uint8Array(48_210)], { type: "application/zip" })],
  [H.spec, new Blob([new Uint8Array(2_412_000)], { type: "application/pdf" })],
]);
/** Адрес сайта мока: статика страницы. У флота у сайта свой поддомен. */
const SITE = "/mock/s/3f9a1c7e5b2d4f608a1c3e5f7b9d0c2e/index.html";

const FLOW = [
  "sequenceDiagram",
  "  participant C as Сессия",
  "  participant H as Host",
  "  participant R as Хранилище",
  "  participant P as Страница",
  "  C->>H: file_send (путь)",
  "  H->>R: содержимое по хэшу",
  "  H-->>C: хэш и размер",
  "  P->>R: содержимое по хэшу",
].join("\n");

const ANSWER = ["Сверил: отчёт сходится с требованиями, расхождение одно — время ответа в 14:00. График, снимок и сборку отправил, отчёт поднял сайтом. Отправка идёт так:", "```mermaid\n" + FLOW + "\n```"].join("\n\n");

/** Ход с файлами: человек загрузил макет и требования; сессия отправила график, снимок и архив, подняла отчёт сайтом; схема — блоком текста. */
export function showTurn(t: number, me: string, ask: string): Ev[] {
  const a = uid("t"), b = uid("t"), c = uid("t"), d = uid("t"), e = uid("t");
  return [
    say(ask, t, { files: [{ name: "maket.png", hash: H.shot, size: 66480 }, { name: "spec.pdf", hash: H.spec, size: 2_412_000 }] }),
    reply([text("Файлы вижу в uploads/. Соберу время ответа из журнала скриптом: числа в разговор тащить незачем."), use(a, "Bash", { command: "node scripts/report.mjs --day", description: "График, отчёт и сборка по журналу за сутки" })], t + 5_000),
    got(a, "out/latency.svg  4,8 КБ\nout/site/  3 файла, 9,1 КБ\ndist/report.zip  47 КБ", t + 9_000),
    reply([
      use(b, SEND_TOOL, { to: me, path: "out/latency.svg", title: "Время ответа за сутки" }),
      use(c, SEND_TOOL, { to: me, path: "shots/header-390.png", title: "Шапка на телефоне" }),
      use(d, SEND_TOOL, { to: me, path: "dist/report.zip", title: "Сборка отчёта" }),
      use(e, SITE_TOOL, { to: me, dir: "out/site", title: "Отчёт за сутки" }),
    ], t + 12_000),
    got(b, JSON.stringify({ name: "latency.svg", hash: H.chart, size: 4835 }), t + 12_400),
    got(c, JSON.stringify({ name: "header-390.png", hash: H.shot, size: 66480 }), t + 12_500),
    got(d, JSON.stringify({ name: "report.zip", hash: H.zip, size: 48210 }), t + 12_600),
    got(e, JSON.stringify({ url: SITE, files: 3, size: 9318 }), t + 13_400),
    reply([text(ANSWER)], t + 16_000),
    done(t + 17_000, 17_000, 0.06, 3, 41_000),
  ];
}

/** Ход, где отправленного содержимого в хранилище нет: страница показывает слово отказа на месте файла. */
export function goneTurn(t: number, me: string, ask: string, answer: string): Ev[] {
  const a = uid("t");
  return [
    say(ask, t),
    reply([use(a, SEND_TOOL, { to: me, path: "out/builds.png", title: "Сборки по машинам" })], t + 4_000),
    got(a, JSON.stringify({ name: "builds.png", hash: H.gone, size: 18204 }), t + 4_400),
    reply([text(answer)], t + 6_000),
    done(t + 7_000, 7_000, 0.03, 2, 21_000),
  ];
}
