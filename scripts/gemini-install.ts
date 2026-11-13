// Liga o Gemini CLI ao Habblaud: acrescenta o hook do Habblaud (mod/habblaud-gemini/hook.mjs) na seção "hooks" do
// ~/.gemini/settings.json, um grupo por evento observado, com backup antes. Os outros hooks e configurações ficam.
//
//   npm run gemini:install     acrescenta (ou atualiza) os hooks do Habblaud
//   npm run gemini:uninstall   tira só os hooks do Habblaud
//   npm run gemini:status      confere
//
// O comando do hook usa o caminho absoluto do Node que rodou o instalador (o Gemini roda os hooks com um ambiente
// enxuto, onde o PATH do seu shell pode não valer). Se mover a pasta do Habblaud ou trocar de Node, rode de novo.
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultGeminiDir } from '../server/sources/gemini/discover';
import { GEMINI_HOOK_EVENTS } from '../server/sources/gemini/source';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HOOK = join(ROOT, 'mod', 'habblaud-gemini', 'hook.mjs');
export const HOOK_NAME = 'habblaud';
const DEFAULT_PORT = 4747;
/** O hook nunca espera mais que ~1,5 s pelo Habblaud; o prazo dá folga para o Node subir. */
const HOOK_TIMEOUT_MS = 5_000;

type Rec = Record<string, unknown>;
interface HookCfg {
  name?: string;
  type?: string;
  command?: string;
  timeout?: number;
}
interface Group {
  matcher?: string;
  hooks?: HookCfg[];
}

const isObject = (v: unknown): v is Rec => !!v && typeof v === 'object' && !Array.isArray(v);

/** JSON com comentários (o Gemini aceita `//` e `/* *\/` no settings.json). */
export function parseJsonc(text: string): unknown {
  let out = '';
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      out += c;
      if (c === '\\') out += text[++i] ?? '';
      else if (c === '"') inStr = false;
    } else if (c === '"') {
      inStr = true;
      out += c;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

export function hookCommand(node = process.execPath, hook = HOOK): string {
  return `"${node}" "${hook}"`;
}

const isOurs = (h: HookCfg) => h?.name === HOOK_NAME || (typeof h?.command === 'string' && h.command.includes('habblaud-gemini/hook.mjs'));

/** Tira os hooks do Habblaud de todas as listas (grupos que ficam vazios somem). */
export function withoutOurs(hooks: Rec): Rec {
  const out: Rec = {};
  for (const [event, list] of Object.entries(hooks)) {
    if (!Array.isArray(list)) {
      out[event] = list;
      continue;
    }
    const kept = (list as Group[])
      .map((g) => (isObject(g) && Array.isArray(g.hooks) ? { ...g, hooks: g.hooks.filter((h) => !isOurs(h)) } : g))
      .filter((g) => !(isObject(g) && Array.isArray(g.hooks) && g.hooks.length === 0));
    if (kept.length) out[event] = kept;
  }
  return out;
}

export function withOurs(hooks: Rec, command: string): Rec {
  const out = withoutOurs(hooks);
  for (const event of GEMINI_HOOK_EVENTS) {
    const list = Array.isArray(out[event]) ? [...(out[event] as Group[])] : [];
    list.push({ matcher: '*', hooks: [{ name: HOOK_NAME, type: 'command', command, timeout: HOOK_TIMEOUT_MS }] });
    out[event] = list;
  }
  return out;
}

function readSettings(file: string): Rec {
  if (!existsSync(file)) return {};
  const text = readFileSync(file, 'utf8');
  if (!text.trim()) return {};
  const parsed = parseJsonc(text);
  if (!isObject(parsed)) throw new Error(`${file} não é um objeto JSON`);
  return parsed;
}

function writeSettings(file: string, data: Rec): string | undefined {
  mkdirSync(dirname(file), { recursive: true });
  let backup: string | undefined;
  if (existsSync(file)) {
    backup = `${file}.habblaud-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    copyFileSync(file, backup);
  }
  const tmp = `${file}.habblaud-tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
  return backup;
}

function tildify(p: string): string {
  const home = homedir();
  return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

function port(): number {
  const p = Number(process.env.HABBLAUD_PORT);
  return Number.isInteger(p) && p > 0 && p < 65_536 ? p : DEFAULT_PORT;
}

async function health(p: number): Promise<Rec | undefined> {
  try {
    const res = await fetch(`http://127.0.0.1:${p}/api/health`, { signal: AbortSignal.timeout(2_000) });
    const json = (await res.json()) as unknown;
    return isObject(json) ? json : undefined;
  } catch {
    return undefined;
  }
}

function countOurs(hooks: unknown): number {
  if (!isObject(hooks)) return 0;
  let n = 0;
  for (const event of GEMINI_HOOK_EVENTS) {
    const list = hooks[event];
    if (Array.isArray(list) && (list as Group[]).some((g) => isObject(g) && Array.isArray(g.hooks) && g.hooks.some(isOurs))) n++;
  }
  return n;
}

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? 'status';
  const dir = defaultGeminiDir(process.env, homedir());
  const file = join(dir, 'settings.json');
  const p = port();

  if (cmd === 'install') {
    const settings = readSettings(file);
    const hooks = isObject(settings.hooks) ? settings.hooks : {};
    settings.hooks = withOurs(hooks, hookCommand());
    const backup = writeSettings(file, settings);
    const cfgDir = join(homedir(), '.habblaud');
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(join(cfgDir, 'gemini-hook.json'), `${JSON.stringify({ port: p }, null, 2)}\n`);
    console.log(`✓ ${tildify(file)}: hooks do Habblaud em ${GEMINI_HOOK_EVENTS.size} eventos${backup ? ` (backup: ${tildify(backup)})` : ''}`);
    console.log(`✓ configuração do hook gravada em ~/.habblaud/gemini-hook.json (porta ${p})`);
    console.log('\nPronto. Sessões novas do Gemini CLI já entram no escritório; as abertas, depois de reabrir o `gemini`.');
    console.log('Para conferir: npm run gemini:status · Para desfazer: npm run gemini:uninstall');
    return;
  }
  if (cmd === 'uninstall') {
    if (!existsSync(file)) return void console.log(`${tildify(file)} não existe: nada a desfazer.`);
    const settings = readSettings(file);
    if (!countOurs(settings.hooks)) return void console.log(`${tildify(file)}: sem hooks do Habblaud.`);
    const rest = withoutOurs(isObject(settings.hooks) ? settings.hooks : {});
    if (Object.keys(rest).length) settings.hooks = rest;
    else delete settings.hooks;
    const backup = writeSettings(file, settings);
    console.log(`✓ ${tildify(file)}: hooks do Habblaud removidos${backup ? ` (backup: ${tildify(backup)})` : ''}`);
    return;
  }
  if (cmd !== 'status') {
    console.error('Uso: npm run gemini:install | gemini:uninstall | gemini:status');
    process.exitCode = 2;
    return;
  }
  const settings = existsSync(file) ? readSettings(file) : {};
  const n = countOurs(settings.hooks);
  const enabled = !(isObject(settings.hooksConfig) && settings.hooksConfig.enabled === false);
  console.log(`• ${tildify(file)}: ${n ? `instalado em ${n} de ${GEMINI_HOOK_EVENTS.size} eventos` : 'hooks do Habblaud não instalados (npm run gemini:install)'}`);
  if (!enabled) console.log('  ⚠ hooksConfig.enabled está false: o Gemini não roda nenhum hook.');
  const h = await health(p);
  if (!h) console.log(`Habblaud em http://127.0.0.1:${p}: fora do ar.`);
  else {
    const src = Array.isArray(h.sources) ? (h.sources as Rec[]).find((s) => s.provider === 'gemini') : undefined;
    console.log(
      `Habblaud em http://127.0.0.1:${p}: ${h.geminiEvents ? 'recebendo os eventos do Gemini' : 'sem a fonte do Gemini (rode npm run docker:up de novo, ou HABBLAUD_GEMINI=0 está ligado)'}` +
        (src ? ` · ${String(src.sessions ?? 0)} sessão(ões) aberta(s)` : ''),
    );
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`Erro: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  });
}
