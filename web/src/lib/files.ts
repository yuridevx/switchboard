// Файлы флота: содержимое лежит в хранилище по хэшу SHA-256. Страница грузит и читает его по подписанным ссылкам, мимо машины и Worker'а.
import { filesGet, filesPut } from "@sb/protocol";
import { useQuery } from "@tanstack/react-query";
import { api, putBytes } from "../api.ts";

/** Файл в разговоре: имя, хэш содержимого и размер. Самих байтов в разговоре нет. */
export type FileRef = { name: string; hash: string; size: number };

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
export const sha256 = async (file: Blob): Promise<string> => hex(await crypto.subtle.digest("SHA-256", await file.arrayBuffer()));

/** Файл человека — в хранилище: хэш считает браузер; содержимое, которое там уже лежит, не грузится второй раз. */
export async function upload(file: File): Promise<FileRef> {
  const hash = await sha256(file);
  const { upload: links } = await api.call(filesPut, { files: [{ hash, size: file.size }] });
  if (links[hash]) await putBytes(links[hash], file);
  return { name: file.name, hash, size: file.size };
}

/** Содержимое по хэшу. Оно не меняется, поэтому берётся один раз на страницу. */
export function useBytes(hash: string | null) {
  return useQuery({
    queryKey: ["files.bytes", hash], enabled: !!hash, retry: false, staleTime: Infinity,
    queryFn: async () => {
      const { url } = await api.call(filesGet, { hash: hash! });
      const res = await fetch(url);
      if (!res.ok) throw new Error(`хранилище ответило ${res.status}`);
      return res.arrayBuffer();
    },
  });
}

/** Скачать в браузере: ссылка несёт имя файла. */
export async function download(f: FileRef): Promise<void> {
  const { url } = await api.call(filesGet, { hash: f.hash, name: f.name });
  const a = document.createElement("a");
  a.href = url;
  a.download = f.name;
  a.rel = "noopener";
  document.body.append(a);
  a.click();
  a.remove();
}
