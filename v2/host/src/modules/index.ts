// Модули Host: порядок списка — порядок вызова. Модуль импортирует чужое только через договор и publicApi соседа.
import type { Module } from "../core/contract.ts";
import { make as accounts } from "./accounts/accounts.ts";
import { make as chat } from "./chat/chat.ts";
import { make as incidents } from "./incidents/incidents.ts";
import { make as machine } from "./machine/machine.ts";
import { make as points } from "./points/points.ts";
import { make as profiles } from "./profiles/profiles.ts";
import { make as proxy } from "./proxy/proxy.ts";
import { make as remote } from "./remote/remote.ts";
import { make as shell } from "./shell/shell.ts";

export const modules = (): Module[] => [chat(), accounts(), profiles(), points(), proxy(), shell(), incidents(), remote(), machine()];
