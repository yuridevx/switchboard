// Открыть экран по ссылке: ?open=settings/github → #/settings/github. Остальные параметры адреса остаются.
export function openFromQuery(search: string, hash: string): { search: string; hash: string } | null {
  const q = new URLSearchParams(search);
  const open = q.get("open");
  if (!open || !/^[a-z0-9@~._/-]+$/i.test(open)) return null;
  q.delete("open");
  const rest = q.toString();
  // приглашение в адресе важнее: сначала вход
  return { search: rest ? "?" + rest : "", hash: /invite=/.test(hash) ? hash : "#/" + open.replace(/^\/+/, "") };
}
