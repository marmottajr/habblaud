// Descoberta das pastas e contas do Kiro: HABBLAUD_KIRO_DIRS, KIRO_HOME, KIRO_SESSIONS_DIR ou ~/.kiro; no WSL, também
// as do Windows (/mnt/c/Users/<usuário>/.kiro, HABBLAUD_KIRO_WINDOWS=0 desliga).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { DetectedAccount } from '../../accounts/detect';
import { isWindowsMount, isWsl } from './liveness';

export const KIRO_COLOR = '#7c3aed'; // Roxo vibrante do Kiro

export interface KiroDir {
  /** Pasta da conta (~/.kiro): é ela que vai no AccountsService. */
  dir: string;
  /** Onde ficam os .lock/.json/.jsonl (normalmente <dir>/sessions/cli). */
  sessionsDir: string;
  /** Pasta do Windows vista do WSL (/mnt/c/...). */
  windows?: boolean;
}

const SKIP_USERS = new Set(['all users', 'default', 'default user', 'public', 'wsiaccount', 'desktop.ini']);

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Aceita a pasta da conta (~/.kiro), a de sessões (~/.kiro/sessions/cli) ou uma pasta solta com os .lock/.jsonl. */
export function kiroDirOf(raw: string): KiroDir | undefined {
  const p = resolve(raw);
  if (!isDir(p)) return undefined;
  const mk = (dir: string, sessionsDir: string): KiroDir => (isWindowsMount(dir) ? { dir, sessionsDir, windows: true } : { dir, sessionsDir });
  const cli = join(p, 'sessions', 'cli');
  if (isDir(cli)) return mk(p, cli);
  if (/[\\/]sessions[\\/]cli$/.test(p)) return mk(resolve(p, '..', '..'), p);
  try {
    if (readdirSync(p).some((f) => /\.(lock|jsonl)$/.test(f))) return mk(p, p);
  } catch {
    // ignora
  }
  return mk(p, cli); // conta sem sessões ainda: o watcher espera a pasta aparecer
}

/** Pastas do Kiro no Windows vistas do WSL: /mnt/c/Users/<usuário>/.kiro com sessions/cli. */
export function windowsKiroDirs(usersRoot = '/mnt/c/Users'): string[] {
  let names: string[];
  try {
    names = readdirSync(usersRoot);
  } catch {
    return [];
  }
  return names
    .filter((n) => !SKIP_USERS.has(n.toLowerCase()))
    .map((n) => join(usersRoot, n, '.kiro'))
    .filter((d) => isDir(join(d, 'sessions', 'cli')));
}

export interface DiscoverKiroOptions {
  /** Está no WSL? (padrão: detecta). No Docker, passe false. */
  wsl?: boolean;
  windowsUsersRoot?: string;
}

/**
 * Pastas do Kiro a observar, sem repetição: HABBLAUD_KIRO_DIRS (lista separada por vírgula ou ";") substitui tudo;
 * senão KIRO_SESSIONS_DIR, KIRO_HOME ou ~/.kiro e, no WSL, as pastas do Kiro no Windows.
 */
export function discoverKiroDirs(env: NodeJS.ProcessEnv = process.env, home: string = process.env.HOME || '', opts: DiscoverKiroOptions = {}): KiroDir[] {
  const out: KiroDir[] = [];
  const seen = new Set<string>();
  const add = (raw: string) => {
    const d = kiroDirOf(raw);
    if (!d || seen.has(d.sessionsDir)) return;
    seen.add(d.sessionsDir);
    out.push(d);
  };
  const list = env.HABBLAUD_KIRO_DIRS?.split(/[,;\n]/).map((s) => s.trim()).filter(Boolean);
  if (list?.length) {
    list.forEach(add);
    return out;
  }
  const sessions = env.KIRO_SESSIONS_DIR?.trim();
  const custom = env.KIRO_HOME?.trim();
  if (sessions) add(sessions);
  else if (custom) add(custom);
  if (!out.length) add(join(home, '.kiro'));
  if (env.HABBLAUD_KIRO_WINDOWS?.trim() !== '0' && (opts.wsl ?? isWsl(env))) {
    for (const d of windowsKiroDirs(opts.windowsUsersRoot)) add(d);
  }
  return out;
}

/** A primeira pasta do Kiro (compatibilidade: scripts/docker-up.ts monta só ela). */
export function discoverKiroDir(env: NodeJS.ProcessEnv = process.env, home: string = process.env.HOME || ''): string | undefined {
  return discoverKiroDirs(env, home, { wsl: false })[0]?.dir;
}

export function detectKiroAccount(kiroDir: string, env: NodeJS.ProcessEnv = process.env, opts: { windows?: boolean } = {}): DetectedAccount {
  let plan = env.HABBLAUD_KIRO_PLAN?.trim() || env.KIRO_PLAN?.trim();
  let email = env.HABBLAUD_KIRO_EMAIL?.trim() || env.KIRO_EMAIL?.trim();
  let organization = env.HABBLAUD_KIRO_ORG?.trim() || env.KIRO_ORG?.trim();

  // Se não foi definido por env, tenta ler de arquivos de configuração locais em kiroDir
  if (!plan) {
    const planFiles = [join(kiroDir, 'plan'), join(kiroDir, 'plan.txt')];
    for (const pf of planFiles) {
      if (existsSync(pf)) {
        try {
          const content = readFileSync(pf, 'utf-8').trim();
          if (content) {
            plan = content;
            break;
          }
        } catch {}
      }
    }
  }

  // Tenta ler de ~/.kiro/settings/plan.json ou ~/.kiro/user.json
  const settingsJson = join(kiroDir, 'settings', 'plan.json');
  if (existsSync(settingsJson)) {
    try {
      const data = JSON.parse(readFileSync(settingsJson, 'utf-8'));
      if (typeof data.plan === 'string' && !plan) plan = data.plan.trim();
      if (typeof data.email === 'string' && !email) email = data.email.trim();
      if (typeof data.organization === 'string' && !organization) organization = data.organization.trim();
    } catch {}
  }

  const userJson = join(kiroDir, 'user.json');
  if (existsSync(userJson)) {
    try {
      const data = JSON.parse(readFileSync(userJson, 'utf-8'));
      if (typeof data.plan === 'string' && !plan) plan = data.plan.trim();
      if (typeof data.email === 'string' && !email) email = data.email.trim();
      if (typeof data.organization === 'string' && !organization) organization = data.organization.trim();
    } catch {}
  }

  return {
    id: opts.windows ? '.kiro-windows' : '.kiro',
    provider: 'kiro',
    configDir: kiroDir,
    short: opts.windows ? 'W' : 'K',
    name: opts.windows ? 'Kiro (Windows)' : 'Kiro',
    color: KIRO_COLOR,
    ...(plan ? { plan } : {}),
    ...(email ? { email } : {}),
    ...(organization ? { organization } : {}),
  };
}
