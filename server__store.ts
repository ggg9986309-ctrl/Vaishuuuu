import { mkdir, readFile, readdir, rename, writeFile, open, unlink } from "node:fs/promises";
import { join } from "node:path";

// Shared storage interface used by the API and tests.
export interface Store {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown): Promise<void>;
  del(key: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
  /** Creates the key only if it is new. false means it already existed (the idempotency primitive). */
  createOnce(key: string, value: unknown): Promise<boolean>;
  /** Atomic read-modify-write. fn returns the new value, or undefined to leave it unchanged. */
  update<T>(key: string, fn: (cur: T | null) => T | undefined | Promise<T | undefined>): Promise<T | null>;
}


export class MemoryStore implements Store {
  private m = new Map<string, string>();
  async get<T>(key: string) {
    const v = this.m.get(key);
    return v === undefined ? null : (JSON.parse(v) as T);
  }
  async set(key: string, value: unknown) {
    this.m.set(key, JSON.stringify(value));
  }
  async del(key: string) {
    this.m.delete(key);
  }
  async list(prefix: string) {
    return [...this.m.keys()].filter((k) => k.startsWith(prefix)).sort();
  }
  async createOnce(key: string, value: unknown) {
    if (this.m.has(key)) return false;
    this.m.set(key, JSON.stringify(value));
    return true;
  }
  async update<T>(key: string, fn: (cur: T | null) => T | undefined | Promise<T | undefined>) {
    const cur = await this.get<T>(key);
    const next = await fn(cur ? structuredClone(cur) : null);
    if (next === undefined) return cur;
    this.m.set(key, JSON.stringify(next));
    return next;
  }
}


// Render-compatible store. Mount a persistent disk at STORE_DIR (recommended: /var/data)
// to retain settings and the encrypted Telegram session across deploys/restarts.
export class FileStore implements Store {
  private locks = new Map<string, Promise<unknown>>();
  constructor(private dir = process.env.STORE_DIR || ".data") {}
  private async ensure() { await mkdir(this.dir, { recursive: true }); }
  private path(key: string) { return join(this.dir, Buffer.from(key).toString("base64url") + ".json"); }
  private async read<T>(key: string): Promise<T | null> {
    try { return JSON.parse(await readFile(this.path(key), "utf8")) as T; }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
  }
  async get<T>(key: string) { await this.ensure(); return this.read<T>(key); }
  async set(key: string, value: unknown) {
    await this.ensure();
    const target = this.path(key), temp = target + "." + randomFileToken() + ".tmp";
    await writeFile(temp, JSON.stringify(value), { mode: 0o600 });
    await rename(temp, target);
  }
  async del(key: string) { await this.ensure(); try { await unlink(this.path(key)); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; } }
  async list(prefix: string) {
    await this.ensure(); const names = await readdir(this.dir); const keys: string[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      try { const key = Buffer.from(name.slice(0, -5), "base64url").toString(); if (key.startsWith(prefix)) keys.push(key); } catch { /* ignore unrelated files */ }
    }
    return keys.sort();
  }
  async createOnce(key: string, value: unknown) {
    await this.ensure();
    try { const f = await open(this.path(key), "wx", 0o600); try { await f.writeFile(JSON.stringify(value)); } finally { await f.close(); } return true; }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "EEXIST") return false; throw e; }
  }
  async update<T>(key: string, fn: (cur: T | null) => T | undefined | Promise<T | undefined>) {
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    this.locks.set(key, previous.then(() => gate));
    await previous;
    try {
      const cur = await this.get<T>(key);
      const next = await fn(cur === null ? null : structuredClone(cur));
      if (next === undefined) return cur;
      await this.set(key, next); return next;
    } finally { release(); }
  }
}

function randomFileToken() { return `${Date.now()}-${Math.random().toString(36).slice(2)}`; }
