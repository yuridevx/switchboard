// общая библиотека: ею пользуются billing-api, orders-api и reports
export function send(path, body) {
  return { ok: true, path, body };
}
