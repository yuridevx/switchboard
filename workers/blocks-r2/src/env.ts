// Привязки и переменные Worker'а blocks-r2 (config в module.json).
export interface Env {
  /** блоки точек: f/<отпечаток>, тело — zstd */
  BUCKET: R2Bucket;
  /** пара S3 токена R2 бакета точек: ею подписываются ссылки */
  CF_ACCOUNT_ID: string;
  R2_KEY_ID: string;
  R2_KEY_SECRET: string;
  BLOCKS_BUCKET: string;
}
