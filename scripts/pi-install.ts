// Instala (ou remove) a extensão ao vivo do Habblaud no Pi coding agent (~/.pi/agent/extensions/habblaud.ts).
// Roda no HOST, com tsx:
//
//   npm run pi:install     # cria link simbólico (ou cópia) da extensão e grava ~/.habblaud/pi-extension.json
//   npm run pi:uninstall   # remove a extensão do Habblaud (outras extensões ficam intactas)
//   npm run pi:status      # verifica se a extensão está instalada e se o Habblaud está respondendo
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultPiAgentDir, discoverPiDirs } from '../server/sources/pi/accounts';
import { tildify } from './statusline-install';
import { tr } from '../shared/i18n';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const PI_EXTENSION_SRC = join(ROOT, 'mod', 'habblaud-pi', 'habblaud.ts');
export const PI_EXTENSION_FILE = 'habblaud.ts';
export const PI_CONFIG_NAME = 'pi-extension.json';
export const DEFAULT_PORT = 4747;

const USAGE = tr(
  'Uso: npm run pi:<install|uninstall|status> [-- opções]\n\n  install     instala a extensão do Habblaud em <piDir>/extensions/habblaud.ts\n  uninstall   remove a extensão do Habblaud de cada pasta do Pi\n  status      mostra se a extensão está instalada e se o Habblaud está respondendo\n\nOpções:\n  --dry-run        mostra o que mudaria, sem gravar nada\n  --dir <caminho>  usa esta pasta do Pi (padrão: PI_CODING_AGENT_DIR ou ~/.pi/agent)\n  --port <n>       porta do Habblaud (padrão: HABBLAUD_PORT ou {0})\n  -h, --help       mostra esta ajuda',
  [DEFAULT_PORT],
);

interface CliArgs {
  cmd: 'install' | 'uninstall' | 'status';
  dryRun: boolean;
  dir?: string;
  port: number;
  help?: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const cmdRaw = argv[0];
  if (cmdRaw === '-h' || cmdRaw === '--help') return { cmd: 'status', dryRun: false, port: DEFAULT_PORT, help: true };
  if (cmdRaw !== 'install' && cmdRaw !== 'uninstall' && cmdRaw !== 'status') {
    throw new Error(USAGE);
  }
  const envPort = Number.parseInt(process.env.HABBLAUD_PORT ?? '', 10);
  let port = Number.isFinite(envPort) && envPort > 0 && envPort < 65536 ? envPort : DEFAULT_PORT;
  let dryRun = false;
  let dir: string | undefined;

  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') return { cmd: cmdRaw, dryRun, dir, port, help: true };
    if (a === '--dry-run') dryRun = true;
    else if (a === '--dir') {
      dir = argv[++i];
      if (!dir) throw new Error(tr('--dir precisa de um caminho.'));
    } else if (a === '--port') {
      const p = Number.parseInt(argv[++i] ?? '', 10);
      if (!Number.isFinite(p) || p <= 0 || p >= 65536) throw new Error(tr('--port precisa de um número entre 1 e 65535.'));
      port = p;
    } else {
      throw new Error(tr('Opção desconhecida: {0}', [a]));
    }
  }
  return { cmd: cmdRaw, dryRun, dir, port };
}

function targetDirs(explicitDir: string | undefined): string[] {
  const home = process.env.HOME || homedir();
  if (explicitDir) return [resolve(explicitDir)];
  const discovered = discoverPiDirs(process.env, home);
  return discovered.length ? discovered : [defaultPiAgentDir(process.env, home)];
}

function inspectTarget(dest: string): 'linked' | 'copied' | 'other' | 'missing' {
  try {
    const st = lstatSync(dest);
    if (st.isSymbolicLink()) {
      return resolve(dirname(dest), readlinkSync(dest)) === resolve(PI_EXTENSION_SRC) ? 'linked' : 'other';
    }
    if (st.isFile()) {
      return readFileSync(dest, 'utf8') === readFileSync(PI_EXTENSION_SRC, 'utf8') ? 'copied' : 'other';
    }
    return 'other';
  } catch {
    return 'missing';
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return;
  }
  const home = process.env.HOME || homedir();
  const dirs = targetDirs(args.dir);
  const cfgPath = join(home, '.habblaud', PI_CONFIG_NAME);

  if (args.cmd === 'status') {
    for (const d of dirs) {
      const dest = join(d, 'extensions', PI_EXTENSION_FILE);
      const state = inspectTarget(dest);
      if (state === 'linked' || state === 'copied') {
        console.log(tr('✓ {0}: extensão instalada ({1})', [tildify(d), state === 'linked' ? tr('link simbólico') : tr('cópia')]));
      } else if (state === 'other') {
        console.log(tr('! {0}: arquivo diferente em {1}', [tildify(d), tildify(dest)]));
      } else {
        console.log(tr('✗ {0}: extensão não instalada (rode npm run pi:install)', [tildify(d)]));
      }
    }
    try {
      const res = await fetch(`http://127.0.0.1:${args.port}/api/health`, { signal: AbortSignal.timeout(1_500) });
      if (res.ok) {
        const j = (await res.json()) as { piEvents?: boolean };
        console.log(
          j.piEvents
            ? tr('✓ Habblaud respondendo em http://127.0.0.1:{0} com eventos do Pi ativos.', [args.port])
            : tr('! Habblaud respondendo em http://127.0.0.1:{0}, mas a fonte do Pi está desligada.', [args.port]),
        );
      } else {
        console.log(tr('! Habblaud respondeu HTTP {0} em http://127.0.0.1:{1}.', [res.status, args.port]));
      }
    } catch {
      console.log(tr('· Habblaud não está rodando em http://127.0.0.1:{0}.', [args.port]));
    }
    return;
  }

  if (args.cmd === 'install') {
    if (!existsSync(PI_EXTENSION_SRC)) {
      throw new Error(tr('Arquivo da extensão não encontrado: {0}', [PI_EXTENSION_SRC]));
    }
    for (const d of dirs) {
      const extDir = join(d, 'extensions');
      const dest = join(extDir, PI_EXTENSION_FILE);
      if (args.dryRun) {
        console.log(tr('[dry-run] instalaria {0} → {1}', [tildify(PI_EXTENSION_SRC), tildify(dest)]));
        continue;
      }
      mkdirSync(extDir, { recursive: true });
      try {
        lstatSync(dest);
        unlinkSync(dest);
      } catch {
        // não existia
      }
      try {
        symlinkSync(PI_EXTENSION_SRC, dest);
      } catch {
        copyFileSync(PI_EXTENSION_SRC, dest);
      }
      console.log(tr('✓ Extensão instalada em {0}', [tildify(dest)]));
    }
    if (args.dryRun) {
      console.log(tr('[dry-run] gravaria porta {0} em {1}', [args.port, tildify(cfgPath)]));
    } else {
      mkdirSync(dirname(cfgPath), { recursive: true });
      writeFileSync(cfgPath, `${JSON.stringify({ port: args.port }, null, 2)}\n`, 'utf8');
      console.log(tr('✓ Configuração gravada em {0} (porta {1}).', [tildify(cfgPath), args.port]));
      console.log(tr('No Pi aberto, rode /reload (ou abra uma sessão nova) para ativar.'));
    }
    return;
  }

  // uninstall
  for (const d of dirs) {
    const dest = join(d, 'extensions', PI_EXTENSION_FILE);
    const state = inspectTarget(dest);
    if (state === 'missing') {
      console.log(tr('· {0}: extensão não estava instalada.', [tildify(d)]));
      continue;
    }
    if (args.dryRun) {
      console.log(tr('[dry-run] removeria {0}', [tildify(dest)]));
      continue;
    }
    unlinkSync(dest);
    console.log(tr('✓ Extensão removida de {0}', [tildify(dest)]));
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
