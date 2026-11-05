// Снесено: оболочка пишется заново.
export function boot(_options: object): Promise<never> {
  return Promise.reject(new Error("снесено"));
}
