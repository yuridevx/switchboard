// Хэш версии и ссылка на объект R2: подпись SigV4 в адресе, ключ остаётся у подписавшего.
import { createHash, createHmac } from "node:crypto";

export const sha256hex = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex");

/** Строка .sha256 как у sha256sum; её запись делает версию готовой. */
export const shaLine = (hash: string, version: string): string => `${hash}  ${version}.tgz\n`;

export type LinkKey = { accessKeyId: string; secretAccessKey: string; region?: string };

export function presign(key: LinkKey, link: { method: string; host: string; path: string; now?: Date; expires?: number }): string {
  const { method, host, now = new Date(), expires = 3600 } = link;
  const stamp = now.toISOString().replace(/[-:]|\.\d+/g, "");
  const scope = [stamp.slice(0, 8), key.region ?? "auto", "s3", "aws4_request"];
  const path = link.path.split("/").map(encodeURIComponent).join("/");
  const query = `X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=${encodeURIComponent([key.accessKeyId, ...scope].join("/"))}&X-Amz-Date=${stamp}&X-Amz-Expires=${expires}&X-Amz-SignedHeaders=host`;
  const request = [method, path, query, `host:${host}`, "", "host", "UNSIGNED-PAYLOAD"].join("\n");
  const hmac = (k: string | Buffer, s: string) => createHmac("sha256", k).update(s).digest();
  const signing = scope.reduce<string | Buffer>(hmac, `AWS4${key.secretAccessKey}`);
  const signature = hmac(signing, ["AWS4-HMAC-SHA256", stamp, scope.join("/"), sha256hex(request)].join("\n")).toString("hex");
  return `https://${host}${path}?${query}&X-Amz-Signature=${signature}`;
}
