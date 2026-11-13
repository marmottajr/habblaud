// Onde fica a pasta do Gemini CLI e qual conta Google está ativa (só para exibir).
//
// - HABBLAUD_GEMINI_HOME: a pasta (o docker:up passa a do host ao container, que não monta nada do Gemini);
// - GEMINI_CLI_HOME: o Gemini CLI usa <GEMINI_CLI_HOME>/.gemini no lugar de ~/.gemini;
// - senão ~/.gemini.
// Fora do Docker a pasta precisa existir; no Docker vale o que o docker:up mandou.
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface GeminiFound {
  configDir: string;
  email?: string;
}

/** E-mail da conta Google ativa no Gemini CLI (<pasta>/google_accounts.json: {active}). */
export function geminiEmail(dir: string): string | undefined {
  try {
    const raw = JSON.parse(readFileSync(join(dir, 'google_accounts.json'), 'utf8')) as { active?: unknown };
    return typeof raw.active === 'string' && /^[^\s@]+@[^\s@]+$/.test(raw.active) ? raw.active : undefined;
  } catch {
    return undefined;
  }
}

/** Pasta padrão do Gemini CLI neste computador. */
export function defaultGeminiDir(env: NodeJS.ProcessEnv, home: string): string {
  const explicit = env.HABBLAUD_GEMINI_HOME?.trim();
  if (explicit) return resolve(explicit.replace(/^~(?=[\\/]|$)/, home));
  const cliHome = env.GEMINI_CLI_HOME?.trim();
  return join(cliHome ? resolve(cliHome) : home, '.gemini');
}

export function discoverGemini(env: NodeJS.ProcessEnv, home: string, inDocker: boolean): GeminiFound | undefined {
  if (inDocker) {
    const dir = env.HABBLAUD_GEMINI_HOME?.trim();
    if (!dir) return undefined;
    const email = env.HABBLAUD_GEMINI_EMAIL?.trim();
    return email ? { configDir: dir, email } : { configDir: dir };
  }
  const dir = defaultGeminiDir(env, home);
  if (!existsSync(dir)) return undefined;
  const email = geminiEmail(dir);
  return email ? { configDir: dir, email } : { configDir: dir };
}
