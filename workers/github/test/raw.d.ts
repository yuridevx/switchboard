// Текст файла через Vite: import x from "файл?raw".
declare module "*?raw" {
  const text: string;
  export default text;
}
