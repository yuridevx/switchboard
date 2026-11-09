// Привязки и переменные Worker'а blocks-ch (config в module.json).
export interface Env {
  /** ClickHouse флота: Workers VPC — туннель Cloudflare до HTTP-входа ClickHouse на машине; публичного адреса у него нет */
  CH: Fetcher;
  /** пользователь ClickHouse этого флота: права только на свою базу, вход только с машины */
  CH_USER: string;
  /** его пароль; им же подписываются ссылки на блоки */
  CH_PASSWORD: string;
  /** адрес этого Worker'а: ссылки на блоки ведут сюда */
  BLOCKS_URL: string;
}
