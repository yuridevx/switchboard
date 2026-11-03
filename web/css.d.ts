// Стили модуля — обычный файл .css: упаковка кладёт его текст в код.
declare module "*.css" {
  const text: string;
  export default text;
}
