#!/usr/bin/env node
// switchboard invite — выдача ключа флота. Секрет флота — только из stdin, ключ — в stdout.
//   <секрет> | node invite.ts host laptop
//   <секрет> | node invite.ts client panel-desk --url https://<адрес пульта>/
//   <секрет> | node invite.ts client phone --qr https://<адрес приложения телефона>/
// Списка выданных ключей нет нигде: gate проверяет подпись тем же секретом.
import { newKid, sign } from "./src/key.ts";

const USAGE = "использование: <секрет флота в stdin> | switchboard invite <host|client> <имя> [--url <адрес>] [--qr <адрес>]";

async function readStdin(): Promise<string> {
  const parts: Buffer[] = [];
  for await (const c of process.stdin) parts.push(c as Buffer);
  return Buffer.concat(parts).toString("utf8").replace(/\r?\n$/, "");
}

async function main(argv: string[]): Promise<number> {
  const [role, name, flag, base] = argv;
  if ((role !== "host" && role !== "client") || !name || (flag && flag !== "--url" && flag !== "--qr") || (flag && !base)) {
    console.error(USAGE);
    return 2;
  }
  if (process.stdin.isTTY) {
    console.error("invite: секрет флота ждём в stdin, а не с клавиатуры\n" + USAGE);
    return 2;
  }
  const secret = await readStdin();
  if (!secret) {
    console.error("invite: секрет флота не пришёл в stdin");
    return 1;
  }
  const key = await sign(secret, role, name, newKid());
  if (!flag) {
    console.log(key);
    return 0;
  }
  // ключ — после #: сервер его не видит, приложение кладёт его в своё хранилище
  const url = `${base.endsWith("/") ? base : base + "/"}#${key}`;
  if (flag === "--qr") {
    const { default: qr } = await import("qrcode-terminal");
    qr.generate(url, { small: true }, (s: string) => console.error(s));
  }
  console.log(url);
  return 0;
}

process.exitCode = await main(process.argv.slice(2));
