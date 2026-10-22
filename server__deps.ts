import { GroqProvider } from "./server__ai.ts";
import type { Deps, Env } from "./server__service.ts";
import { FileStore } from "./server__store.ts";
import { GramGateway } from "./server__telegram.ts";

export function readEnv(e: Record<string, string | undefined> = process.env): Env {
  const id = Number(e.TG_API_ID);
  return {
    adminPassword: e.ADMIN_PASSWORD || undefined,
    appSecret: e.APP_SECRET || undefined,
    tgApiId: Number.isSafeInteger(id) && id > 0 ? id : undefined,
    tgApiHash: e.TG_API_HASH || undefined,
    groqKey: e.GROQ_API_KEY || undefined,
  };
}

export function renderDeps(): Deps {
  const env = readEnv();
  return {
    store: new FileStore(process.env.STORE_DIR || ".data"),
    env,
    gateway: () => (env.tgApiId && env.tgApiHash ? new GramGateway(env.tgApiId, env.tgApiHash) : null),
    ai: () => (env.groqKey ? new GroqProvider(env.groqKey) : null),
    now: () => new Date(),
  };
}
