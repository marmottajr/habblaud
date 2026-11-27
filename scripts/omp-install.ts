// Instala (ou remove) a extensão do Habblaud no omp (oh-my-pi). Roda no HOST, com tsx:
//
//   npm run omp:install     # grava <pasta do omp>/extensions/habblaud.ts (um loader de uma linha) e a porta
//   npm run omp:uninstall   # apaga só esse arquivo (a porta em ~/.habblaud/omp-extension.json fica)
//   npm run omp:status      # mostra, por pasta, se a extensão está instalada e se o Habblaud está respondendo
//   (opções: --dry-run, --port <n>)
//
// A extensão (mod/habblaud-omp/habblaud.ts) manda ao escritório o que as sessões do omp fazem, entrega as mensagens da
// gaveta e, com HABBLAUD_OMP_PERMISSOES=1 no ambiente do omp, deixa decidir pelo escritório as ferramentas que alteram
// arquivos ou executam código.
//
// Pastas: as mesmas contas do omp que o servidor acompanha (discoverOmpDirs: HABBLAUD_OMP_DIRS, que substitui tudo,
// PI_CODING_AGENT_DIR ou ~/.omp/agent).
//
// O arquivo gravado carrega a extensão DESTE repositório (`export { default } from "file:///.../habblaud.ts"`): um
// `git pull` atualiza a extensão sem reinstalar. O arquivo do Habblaud é reconhecido pela marca na primeira linha;
// um habblaud.ts sem a marca é de outra pessoa e nunca é sobrescrito nem apagado. Nada mais em extensions/ (as do Orca,
// por exemplo) nem na configuração do omp é lido ou gravado.
//
// A porta fica em ~/.habblaud/omp-extension.json ({"port": n}), fora da extensão: mudar a porta não pede reinstalar.
// HABBLAUD_PORT no ambiente do omp tem precedência sobre o arquivo.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { discoverOmpDirs } from '../server/sources/omp/accounts';
import { tildify } from './statusline-install';
import { tr } from '../shared/i18n';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const EXTENSION_SOURCE = join(ROOT, 'mod', 'habblaud-omp', 'habblaud.ts');
/** Nome do arquivo na pasta extensions/ do omp. */
export const EXTENSION_FILE = 'habblaud.ts';
/** Primeira linha do arquivo do Habblaud: é por ela que ele é reconhecido (instalar, atualizar, remover). */
export const MARK = '// @habblaud-managed-omp-extension';
export const DEFAULT_PORT = 4747;
/** Configuração lida pela extensão (porta), em ~/.habblaud. */
export const CONFIG_NAME = 'omp-extension.json';

const USAGE = tr('Uso: npm run omp:<install|uninstall|status> [-- opções]\n\n  install     grava a extensão do Habblaud em extensions/ de cada pasta do omp\n  uninstall   apaga a extensão do Habblaud de cada pasta (as outras extensões ficam)\n  status      mostra se a extensão está instalada e se o Habblaud está respondendo\n\nOpções:\n  --dry-run   mostra o que mudaria, sem gravar nada\n  --port <n>  porta do Habblaud (padrão: HABBLAUD_PORT ou {0})\n  -h, --help  mostra esta ajuda\n\nPastas: HABBLAUD_OMP_DIRS (lista separada por vírgula), PI_CODING_AGENT_DIR ou ~/.omp/agent.\nPermissões pelo escritório (opcional): abra o omp com HABBLAUD_OMP_PERMISSOES=1 e --approval-mode yolo.', [DEFAULT_PORT]);

// ---------------------------------------------------------------------------------------------
// Funções puras (testadas em server/test/omp-install.test.ts)
// ---------------------------------------------------------------------------------------------

/** O conteúdo do loader: a marca e uma linha que reexporta a extensão do repositório. */
export function loaderContent(sourcePath: string): string {
  return `${MARK}\n// Gerenciado pelo Habblaud (npm run omp:install / omp:uninstall): carrega a extensão do repositório.\nexport { default } from ${JSON.stringify(pathToFileURL(sourcePath).href)};\n`;
}

/** Arquivo do Habblaud: a marca na primeira linha. */
export function isOurs(content: string): boolean {
  return content.split(/\r?\n/, 1)[0]?.trim() === MARK;
}

/** O endereço que o loader instalado carrega (undefined se não dá para ler). */
export function loaderTarget(content: string): string | undefined {
  const m = /export\s*\{\s*default\s*\}\s*from\s*("(?:[^"\\]|\\.)*")/.exec(content);
  if (!m) return undefined;
  try {
    const url = JSON.parse(m[1]) as unknown;
    return typeof url === 'string' ? fileURLToPath(url) : undefined;
  } catch {
    return undefined;
  }
}

export type PlanAction =
  | { action: 'install'; content: string; message: string }
  | { action: 'uninstall'; message: string }
  | { action: 'none'; message: string }
  | { action: 'skip'; message: string };

/** `current`: o conteúdo atual de extensions/habblaud.ts (undefined = não existe). Não grava nada. */
export function planInstall(current: string | undefined, sourcePath: string): PlanAction {
  const content = loaderContent(sourcePath);
  if (current === undefined) return { action: 'install', content, message: tr('extensão instalada') };
  if (!isOurs(current)) return { action: 'skip', message: tr('já existe um {0} que não é do Habblaud; não vou sobrescrevê-lo', [EXTENSION_FILE]) };
  if (current === content) return { action: 'none', message: tr('a extensão já está instalada e atualizada') };
  return { action: 'install', content, message: tr('extensão atualizada (aponta para este repositório)') };
}

export function planUninstall(current: string | undefined): PlanAction {
  if (current === undefined) return { action: 'none', message: tr('não havia nada a remover') };
  if (!isOurs(current)) return { action: 'skip', message: tr('o {0} que existe não é do Habblaud; deixei como está', [EXTENSION_FILE]) };
  return { action: 'uninstall', message: tr('extensão removida') };
}

export type InstallState = 'missing' | 'current' | 'outdated' | 'foreign';

/** Situação do arquivo para o status. */
export function installState(current: string | undefined, sourcePath: string): InstallState {
  if (current === undefined) return 'missing';
  if (!isOurs(current)) return 'foreign';
  return current === loaderContent(sourcePath) ? 'current' : 'outdated';
}

// ---------------------------------------------------------------------------------------------
// Efeitos
// ---------------------------------------------------------------------------------------------

export interface RunOptions {
  command: 'install' | 'uninstall' | 'status';
  dryRun: boolean;
  port: number;
}

export interface Health {
  messages?: boolean;
  permissions?: boolean;
  ompEvents?: boolean;
}

export interface RunContext {
  env: NodeJS.ProcessEnv;
  home: string;
  /** A extensão do repositório (os testes apontam para um arquivo deles). */
  source: string;
  out: (line: string) => void;
  /** Consulta o /api/health do Habblaud (testes injetam um falso). */
  health?: (port: number) => Promise<Health | undefined>;
}

class FatalError extends Error {}

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): RunOptions | 'help' {
  let command: RunOptions['command'] | undefined;
  let dryRun = false;
  const envPort = Number.parseInt(env.HABBLAUD_PORT ?? '', 10);
  let port = Number.isInteger(envPort) && envPort > 0 && envPort < 65_536 ? envPort : DEFAULT_PORT;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') return 'help';
    if (a === '--dry-run') dryRun = true;
    else if (a === '--port') {
      port = Number(argv[++i]);
      if (!Number.isInteger(port) || port <= 0 || port >= 65_536) throw new FatalError(tr('--port precisa de um número entre 1 e 65535.'));
    } else if ((a === 'install' || a === 'uninstall' || a === 'status') && !command) command = a;
    else throw new FatalError(tr('opção desconhecida: {0}\n\n{1}', [a, USAGE]));
  }
  if (!command) throw new FatalError(tr('diga o que fazer: install, uninstall ou status.\n\n{0}', [USAGE]));
  return { command, dryRun, port };
}

export function configPath(home: string): string {
  return join(home, '.habblaud', CONFIG_NAME);
}

/** A porta gravada para a extensão (undefined = não existe ou ilegível). */
export function readConfigPort(home: string): number | undefined {
  try {
    const j: unknown = JSON.parse(readFileSync(configPath(home), 'utf8'));
    const port = j && typeof j === 'object' ? (j as { port?: unknown }).port : undefined;
    return typeof port === 'number' && Number.isInteger(port) && port > 0 && port < 65_536 ? port : undefined;
  } catch {
    return undefined;
  }
}

/** Grava a porta se mudou. Devolve true se gravou. */
function writeConfigPort(home: string, port: number): boolean {
  if (readConfigPort(home) === port) return false;
  mkdirSync(join(home, '.habblaud'), { recursive: true });
  writeFileSync(configPath(home), `${JSON.stringify({ port }, null, 2)}\n`, { mode: 0o644 });
  return true;
}

async function fetchHealth(port: number): Promise<Health | undefined> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1_500) });
    if (!res.ok) return undefined;
    return (await res.json()) as Health;
  } catch {
    return undefined;
  }
}

function readCurrent(file: string): string | undefined {
  return existsSync(file) ? readFileSync(file, 'utf8') : undefined;
}

/** Executa o comando para todas as pastas do omp. Devolve o código de saída. */
export async function run(opts: RunOptions, ctx: RunContext): Promise<number> {
  const { env, home, out } = ctx;
  const dirs = discoverOmpDirs(env, home);
  if (!dirs.length) {
    out(tr('Nenhuma pasta do omp encontrada (~/.omp/agent ou PI_CODING_AGENT_DIR com sessions/). Use HABBLAUD_OMP_DIRS se ela estiver em outro lugar.'));
    return 1;
  }
  let failures = 0;
  let changed = false;
  for (const dir of dirs) {
    const label = tildify(dir, home);
    const file = join(dir, 'extensions', EXTENSION_FILE);
    let current: string | undefined;
    try {
      current = readCurrent(file);
    } catch (err) {
      out(tr('✗ {0}: não consegui ler {1} ({2})', [label, EXTENSION_FILE, (err as Error).message]));
      failures++;
      continue;
    }
    if (opts.command === 'status') {
      const state = installState(current, ctx.source);
      if (state === 'current') out(tr('• {0}: instalada e atualizada', [label]));
      else if (state === 'outdated') {
        const target = loaderTarget(current ?? '');
        const gone = target && !existsSync(target) ? tr(' (esse arquivo não existe mais: a extensão falha ao carregar)') : '';
        out(tr('! {0}: instalada, mas aponta para {1}{2}; rode npm run omp:install para atualizar', [label, target ?? tr('um caminho ilegível'), gone]));
      } else if (state === 'foreign') out(tr('! {0}: existe um {1} que não é do Habblaud', [label, EXTENSION_FILE]));
      else out(tr('✗ {0}: não instalada; rode npm run omp:install', [label]));
      continue;
    }
    const plan = opts.command === 'install' ? planInstall(current, ctx.source) : planUninstall(current);
    if (plan.action === 'none') {
      out(`= ${label}: ${plan.message}`);
      continue;
    }
    if (plan.action === 'skip') {
      out(`✗ ${label}: ${plan.message}`);
      failures++;
      continue;
    }
    if (opts.dryRun) {
      out(tr('~ {0}: {1} (simulação: nada gravado)', [label, plan.message]));
      out(plan.action === 'install' ? tr('  criaria/atualizaria {0}', [file]) : tr('  apagaria {0}', [file]));
      continue;
    }
    try {
      if (plan.action === 'install') {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, plan.content, { mode: 0o644 });
      } else rmSync(file);
      changed = true;
      out(`✓ ${label}: ${plan.message}`);
    } catch (err) {
      out(tr('✗ {0}: não consegui gravar ({1})', [label, (err as Error).message]));
      failures++;
    }
  }

  const cfgFile = tildify(configPath(home), home);
  if (opts.command === 'install') {
    if (opts.dryRun) out(tr('~ configuração ({0}): porta {1} (simulação: nada gravado)', [cfgFile, opts.port]));
    else {
      try {
        if (writeConfigPort(home, opts.port)) out(tr('✓ configuração ({0}): porta {1}', [cfgFile, opts.port]));
      } catch (err) {
        out(tr('✗ não consegui gravar {0} ({1}): a extensão usa HABBLAUD_PORT ou a porta {2}', [cfgFile, (err as Error).message, DEFAULT_PORT]));
        failures++;
      }
    }
  }
  if (opts.command === 'status') {
    const configured = readConfigPort(home);
    out(configured ? tr('Configuração da extensão ({0}): porta {1}.', [cfgFile, configured]) : tr('Configuração da extensão ({0}): não existe (a extensão usa HABBLAUD_PORT ou a porta {1}).', [cfgFile, DEFAULT_PORT]));
    const port = configured ?? opts.port;
    const health = await (ctx.health ?? fetchHealth)(port);
    out(health ? tr('Habblaud respondendo em http://127.0.0.1:{0}.', [port]) : tr('Habblaud em http://127.0.0.1:{0}: fora do ar (a extensão segue calada e o omp funciona normal).', [port]));
    if (health?.ompEvents === false) out(tr('! O Habblaud no ar não tem a fonte do omp ligada (HABBLAUD_OMP=0?): os eventos são ignorados.'));
    out(env.HABBLAUD_OMP_PERMISSOES === '1' ? tr('Modo de decisão das permissões (HABBLAUD_OMP_PERMISSOES): ligado neste ambiente; use o omp com --approval-mode yolo.') : tr('Modo de decisão das permissões (HABBLAUD_OMP_PERMISSOES): desligado neste ambiente (o escritório só mostra o pedido de aprovação do terminal).'));
  }
  if ((opts.command === 'install' || opts.command === 'uninstall') && changed) {
    out(opts.command === 'install' ? tr('Pronto: a próxima sessão do omp carrega a extensão. Para desfazer: npm run omp:uninstall') : tr('A configuração em ~/.habblaud/omp-extension.json fica (só a extensão a lê).'));
  }
  return failures ? 1 : 0;
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed === 'help') {
    console.log(USAGE);
    return;
  }
  process.exitCode = await run(parsed, {
    env: process.env,
    home: process.env.HOME || homedir(),
    source: EXTENSION_SOURCE,
    out: (l) => console.log(l),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err: unknown) => {
    console.error(err instanceof FatalError ? tr('[omp] Erro: {0}', [err.message]) : tr('[omp] Erro inesperado: {0}', [String(err)]));
    process.exitCode = 1;
  });
}
