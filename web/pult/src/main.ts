// Пульт: оболочка сборки. Модули, адрес relay и Worker'ов — из build.json сборки; своих адресов и секретов нет.
import { boot } from "../../shell.ts";
import { PULT } from "./options.ts";

void boot(PULT);
