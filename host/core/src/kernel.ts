export type HostConfig = any;
export class StartError extends Error { reasons: string[] = []; }
export class Mod { constructor(..._a: any[]) {} }
export class Kernel { [k: string]: any; constructor(_o: any) {} async start(): Promise<void> { throw new Error("снесено"); } shutting: any = Promise.resolve(); }
