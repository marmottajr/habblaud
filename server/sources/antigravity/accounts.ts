// Contas do Google Antigravity CLI (`agy`): uma pasta de dados por conta (~/.gemini/antigravity-cli...). Node puro e
// sem dependências do servidor: também é importado por scripts/docker-up.ts (via tsx) no host.
//
// Descoberta: HABBLAUD_ANTIGRAVITY_DIRS (ou HABBLAUD_AGY_DIRS, lista separada por vírgula) substitui tudo; senão
// ANTIGRAVITY_CLI_HOME, `$HOME/.gemini/antigravity-cli*` e `$HOME/.antigravity-cli*` que tenham cara de pasta do
// Antigravity CLI (isAntigravityDir). Letra da conta: o alias de shell `alias x='... agy ...'` (sem variável = a
// pasta padrão); sem alias, uma letra derivada ('G', 'A', 'Y'...) que não colide com as do Claude Code nem do Codex.
// Cor: da paleta das contas, sem repetir as já em uso. Nome: "Antigravity" (ou "Antigravity X" com mais de uma conta).
//
// Privacidade: NUNCA lê tokens, credenciais ou bancos SQLite de conversas; só confere existência de pastas/arquivos.
import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import {
  ACCOUNT_COLORS,
  accountIds,
  expandHome,
  isAntigravityDir,
  parseAccountOverrides,
  readShellAliases,
  shortcutsByDir,
  type AccountOverride,
  type DetectedAccount,
} from '../../accounts/detect';

function splitList(v: string | undefined): string[] {
  return (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/** Pasta padrão do Antigravity CLI: ANTIGRAVITY_CLI_HOME ou $HOME/.gemini/antigravity-cli. */
export function defaultAntigravityHome(env: NodeJS.ProcessEnv, home: string): string {
  const raw = env.ANTIGRAVITY_CLI_HOME?.trim();
  return raw ? expandHome(raw, home) : join(home, '.gemini', 'antigravity-cli');
}

/**
 * Pastas do Antigravity CLI observadas. HABBLAUD_ANTIGRAVITY_DIRS (ou HABBLAUD_AGY_DIRS, lista separada por vírgula)
 * substitui a detecção e vale como veio (só precisa existir). Senão: ANTIGRAVITY_CLI_HOME,
 * `$HOME/.gemini/antigravity-cli*` e `$HOME/.antigravity-cli*` que passem em isAntigravityDir. Ordem estável: a padrão
 * primeiro, depois alfabética.
 */
export function discoverAntigravityDirs(env: NodeJS.ProcessEnv = process.env, home: string = env.HOME || homedir()): string[] {
  const override = splitList(env.HABBLAUD_ANTIGRAVITY_DIRS ?? env.HABBLAUD_AGY_DIRS);
  if (override.length) return [...new Set(override.map((p) => expandHome(p, home)))].filter(isDir);
  const found: string[] = [];
  const main = defaultAntigravityHome(env, home);
  if (isAntigravityDir(main)) found.push(main);
  for (const [parent, prefix] of [
    [join(home, '.gemini'), 'antigravity-cli'],
    [home, '.antigravity-cli'],
  ] as const) {
    try {
      for (const ent of readdirSync(parent, { withFileTypes: true })) {
        if (!ent.name.startsWith(prefix)) continue;
        if (!ent.isDirectory() && !ent.isSymbolicLink()) continue;
        const p = join(parent, ent.name);
        if (isAntigravityDir(p)) found.push(p);
      }
    } catch {
      // pasta inexistente ou ilegível
    }
  }
  const dirs = [...new Set(found.map((p) => expandHome(p, home)))];
  dirs.sort((a, b) => (a === main ? 0 : 1) - (b === main ? 0 : 1) || a.localeCompare(b));
  return dirs;
}

/** Overrides das contas do Antigravity em HABBLAUD_ACCOUNTS (vindos do host, no Docker). */
export function antigravityOverrides(raw: string | undefined): AccountOverride[] {
  return parseAccountOverrides(raw).filter((o) => o.provider === 'antigravity');
}

function matchOverride(overrides: AccountOverride[], id: string, dir: string, home: string): AccountOverride | undefined {
  const norm = (p: unknown) => (typeof p === 'string' && p.trim() ? expandHome(p, home) : undefined);
  return overrides.find((o) => norm(o.mountDir) === dir) ?? overrides.find((o) => norm(o.configDir) === dir) ?? overrides.find((o) => o.id === id);
}

/** Letras candidatas de uma conta sem alias: a inicial do sufixo ("antigravity-cli-work" → W), G, A, Y... e o alfabeto. */
function letterCandidates(dir: string): string[] {
  const suffix = /^\.?(?:antigravity-cli|antigravity|agy)[-_.]+([A-Za-z])/i.exec(basename(dir))?.[1]?.toUpperCase();
  const out = suffix ? [suffix] : [];
  out.push('G', 'A', 'Y', 'V', 'T');
  for (let i = 0; i < 26; i++) out.push(String.fromCharCode(65 + i));
  return out;
}

export interface AntigravityDetectOptions {
  home?: string;
  env?: NodeJS.ProcessEnv;
  /** Letras e cores já usadas pelas outras ferramentas (não se repetem). */
  taken?: { shorts?: Iterable<string>; colors?: Iterable<string> };
}

/**
 * Uma conta por pasta do Antigravity CLI, NA MESMA ORDEM de `dirs`. `configDir` é o caminho para exibição (no Docker,
 * o do host, vindo de HABBLAUD_ACCOUNTS).
 */
export function detectAntigravityAccounts(dirs: string[], opts: AntigravityDetectOptions = {}): DetectedAccount[] {
  const env = opts.env ?? process.env;
  const home = opts.home ?? (env.HOME || homedir());
  const overrides = antigravityOverrides(env.HABBLAUD_ACCOUNTS);
  const shortcuts = shortcutsByDir(readShellAliases(home, 'antigravity'), home, defaultAntigravityHome(env, home));
  const ids = accountIds(dirs);
  const usedShorts = new Set([...(opts.taken?.shorts ?? [])].map((s) => s.toUpperCase()));
  const usedColors = new Set(opts.taken?.colors ?? []);

  const partial = dirs.map((dir, i) => {
    const ov = matchOverride(overrides, ids[i], resolve(dir), home);
    const short = str(ov?.short)?.slice(0, 3) ?? shortcuts.get(resolve(dir));
    return { dir, id: str(ov?.id) ?? ids[i], ov, short: short && !usedShorts.has(short.toUpperCase()) ? short : undefined };
  });
  for (const p of partial) if (p.short) usedShorts.add(p.short.toUpperCase());

  return partial.map((p) => {
    const short = p.short ?? letterCandidates(p.dir).find((l) => !usedShorts.has(l)) ?? '?';
    usedShorts.add(short.toUpperCase());
    let color = str(p.ov?.color);
    if (!color) {
      color = ACCOUNT_COLORS.find((c) => !usedColors.has(c)) ?? ACCOUNT_COLORS[usedColors.size % ACCOUNT_COLORS.length];
      usedColors.add(color);
    }
    const acc: DetectedAccount = {
      id: p.id,
      provider: 'antigravity',
      configDir: str(p.ov?.configDir) ?? p.dir,
      short,
      name: str(p.ov?.name) ?? (dirs.length > 1 ? `Antigravity ${short}` : 'Antigravity'),
      color,
    };
    const plan = str(p.ov?.plan);
    if (plan) acc.plan = plan;
    return acc;
  });
}
