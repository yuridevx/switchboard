// Модули разговора для лесов границы: свежий объект на каждый Host стенда. Единственное место, которое знает, какие модули держат разговор.
import type { Manifest, Module } from "@switchboard/host";
import chatJson from "../module.json" with { type: "json" };
import fleetJson from "../../fleet/module.json" with { type: "json" };

let fresh = 0;

/** Контракт модуля создаёт его объект при загрузке, а объект хранит своё в памяти: новый Host стенда — новая загрузка. */
async function load(name: string): Promise<Module> {
  return ((await import(/* @vite-ignore */ `../../${name}/contract.ts?fresh=${++fresh}`)) as { default: Module }).default;
}

export async function parts(): Promise<Array<{ manifest: Manifest; module: Module }>> {
  return [
    { manifest: chatJson as Manifest, module: await load("chat") },
    { manifest: fleetJson as Manifest, module: await load("fleet") },
  ];
}
