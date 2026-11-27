// Contas do omp (oh-my-pi): uma "agent dir" por conta (~/.omp/agent, ou a de PI_CODING_AGENT_DIR). Node puro e sem
// dependências do servidor: também é importado por scripts/docker-up.ts e scripts/omp-install.ts (via tsx) no host.
//
// Descoberta: HABBLAUD_OMP_DIRS (lista separada por vírgula) substitui tudo; senão PI_CODING_AGENT_DIR; senão
// ~/.omp/agent. Só vale a pasta que tem `sessions/` dentro (omp nunca usado fica de fora, sem aviso). Id da conta: o
// nome da pasta-mãe da agent dir (`~/.omp/agent` → `.omp`); repetido ganha `~2`, `~3` (como o Codex). Letra: o alias de
// shell `alias x='PI_CODING_AGENT_DIR=... omp'` (sem a variável = pasta padrão); sem alias, uma letra derivada que não
// colide com as das outras contas. Cor: da paleta das contas, sem repetir as das outras.
//
// Privacidade: só confere a existência de `sessions/`; `agent.db`, `config.yml` e `models.yml` (credenciais, chaves)
// nunca são abertos. Dos arquivos de shell, só as linhas `alias X='... omp ...'`. No Docker o host manda tudo pronto em
// HABBLAUD_ACCOUNTS (`provider: 'omp'`, com o `configDir` do host).
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import {
  ACCOUNT_COLORS,
  expandHome,
  parseAccountOverrides,
  readShellAliases,
  shortcutsByDir,
  type AccountOverride,
  type DetectedAccount,
} from '../../accounts/detect';

export const OMP_SESSIONS_DIR = 'sessions';

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

/** Agent dir padrão do omp: PI_CODING_AGENT_DIR ou $HOME/.omp/agent. */
export function defaultOmpDir(env: NodeJS.ProcessEnv, home: string): string {
  const raw = env.PI_CODING_AGENT_DIR?.trim();
  return raw ? expandHome(raw, home) : join(home, '.omp', 'agent');
}

/**
 * Agent dirs do omp observadas: HABBLAUD_OMP_DIRS (substitui tudo), senão PI_CODING_AGENT_DIR, senão ~/.omp/agent.
 * Só entra a pasta com `sessions/`.
 */
export function discoverOmpDirs(env: NodeJS.ProcessEnv = process.env, home: string = env.HOME || homedir()): string[] {
  const override = splitList(env.HABBLAUD_OMP_DIRS);
  const candidates = override.length ? override.map((p) => expandHome(p, home)) : [defaultOmpDir(env, home)];
  return [...new Set(candidates)].filter((dir) => isDir(join(dir, OMP_SESSIONS_DIR)));
}

/** Overrides das contas do omp em HABBLAUD_ACCOUNTS (vindos do host, no Docker). */
export function ompOverrides(raw: string | undefined): AccountOverride[] {
  return parseAccountOverrides(raw).filter((o) => o.provider === 'omp');
}

function matchOverride(overrides: AccountOverride[], id: string, dir: string, home: string): AccountOverride | undefined {
  const norm = (p: unknown) => (typeof p === 'string' && p.trim() ? expandHome(p, home) : undefined);
  return overrides.find((o) => norm(o.mountDir) === dir) ?? overrides.find((o) => norm(o.configDir) === dir) ?? overrides.find((o) => o.id === id);
}

/** Ids das contas do omp (nome da pasta-mãe da agent dir), na ordem de `dirs`, desambiguados com `~2`, `~3`. */
export function ompAccountIds(dirs: string[]): string[] {
  const seen = new Map<string, number>();
  return dirs.map((d) => {
    const base = basename(dirname(resolve(d))) || basename(d) || d;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base}~${n}`;
  });
}

/** Letras candidatas de uma conta sem alias: O, depois o alfabeto. */
function letterCandidates(): string[] {
  const out = ['O', 'P'];
  for (let i = 0; i < 26; i++) out.push(String.fromCharCode(65 + i));
  return out;
}

export interface OmpDetectOptions {
  home?: string;
  env?: NodeJS.ProcessEnv;
  /** Letras e cores já usadas pelas outras contas (não se repetem). */
  taken?: { shorts?: Iterable<string>; colors?: Iterable<string> };
}

/**
 * Uma conta por agent dir do omp, NA MESMA ORDEM de `dirs`. `configDir` é o caminho para exibição (no Docker, o do host,
 * vindo de HABBLAUD_ACCOUNTS). Sem e-mail nem plano (não sai sem ler credenciais).
 */
export function detectOmpAccounts(dirs: string[], opts: OmpDetectOptions = {}): DetectedAccount[] {
  const env = opts.env ?? process.env;
  const home = opts.home ?? (env.HOME || homedir());
  const overrides = ompOverrides(env.HABBLAUD_ACCOUNTS);
  const shortcuts = shortcutsByDir(readShellAliases(home, 'omp'), home, defaultOmpDir(env, home));
  const ids = ompAccountIds(dirs);
  const usedShorts = new Set([...(opts.taken?.shorts ?? [])].map((s) => s.toUpperCase()));
  const usedColors = new Set(opts.taken?.colors ?? []);

  const partial = dirs.map((dir, i) => {
    const ov = matchOverride(overrides, ids[i], resolve(dir), home);
    const short = str(ov?.short)?.slice(0, 3) ?? shortcuts.get(resolve(dir));
    return { dir, id: str(ov?.id) ?? ids[i], ov, short: short && !usedShorts.has(short.toUpperCase()) ? short : undefined };
  });
  for (const p of partial) if (p.short) usedShorts.add(p.short.toUpperCase());

  return partial.map((p) => {
    const short = p.short ?? letterCandidates().find((l) => !usedShorts.has(l)) ?? '?';
    usedShorts.add(short.toUpperCase());
    let color = str(p.ov?.color);
    if (!color) {
      color = ACCOUNT_COLORS.find((c) => !usedColors.has(c)) ?? ACCOUNT_COLORS[usedColors.size % ACCOUNT_COLORS.length];
      usedColors.add(color);
    }
    return {
      id: p.id,
      provider: 'omp',
      configDir: str(p.ov?.configDir) ?? p.dir,
      short,
      name: str(p.ov?.name) ?? (dirs.length > 1 ? `omp ${short}` : 'omp'),
      color,
    };
  });
}
