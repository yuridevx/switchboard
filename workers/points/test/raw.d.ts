// Текст файла импортом ?raw — vite отдаёт файл строкой.
declare module "*?raw" {
  const text: string;
  export default text;
}
