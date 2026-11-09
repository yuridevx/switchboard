// Привязки и переменные Worker'а blocks-ch (config в module.json).
export interface Env {
  /** вход ClickHouse флота: туннель Cloudflare до машины, впускает только Cloudflare Access с сервисным токеном */
  CH_URL: string;
  /** сервисный токен Access этого Worker'а */
  CH_ACCESS_ID: string;
  CH_ACCESS_SECRET: string;
  /** пользователь ClickHouse этого флота: права только на свою базу, вход только с машины */
  CH_USER: string;
  /** его пароль; им же подписываются ссылки на блоки */
  CH_PASSWORD: string;
  /** адрес этого Worker'а: ссылки на блоки ведут сюда */
  BLOCKS_URL: string;
}
