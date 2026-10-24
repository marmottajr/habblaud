// Explicação em linguagem de leigo de um pedido de permissão ("Pede permissão" no escritório): o que o agente quer
// fazer, onde (em palavras, nunca só o caminho cru) e o risco de aprovar (baixo, médio ou alto). Sem modelo de IA:
// só regras, a partir do nome da ferramenta e dos argumentos que o hook PermissionRequest manda. Quem usa o
// escritório muitas vezes não é programador e precisa entender o que está aprovando; o nome técnico, o caminho e o
// diff ficam em "Detalhes técnicos" (client/src/ui/permission.ts).
//
// Regras de risco:
// - baixo: ler; gravar ou editar dentro do projeto da sessão, no caderno interno do Claude Code (~/.claude*), do
//   Codex (~/.codex*) ou do Habblaud (~/.habblaud); rodar testes, build, lint e scripts do projeto;
// - médio: comando que cria ou altera fora do projeto, instalar pacote, git commit/push/pull, acesso à rede, nuvem,
//   encerrar programas, ferramentas MCP que mudam algo;
// - alto: apagar (rm, git reset --hard, git clean, force push, DROP/DELETE/TRUNCATE), sudo, mandar mensagem ou
//   e-mail a alguém, dinheiro, mexer em chaves e senhas (~/.ssh, .env, credenciais), baixar e executar da internet.
// Código puro (shared/): usado pelo servidor ao registrar o pedido e pelo modo demonstração; HABBLAUD_EXPLICAR=claude
// (server/permissions/explain-claude.ts) só refina o texto por cima disto e nunca abaixa o risco.
import { basename, maskSecrets, shellWords, splitShell, truncate } from './activity';
import { tr } from './i18n';
import type { Activity, PlainExplanation, PlainRisk } from './types';

/** O que a explicação sabe da sessão: só para dizer "no projeto X" e "o agente Y". Tudo opcional. */
export interface ExplainContext {
  /** Nome do agente (AgentInfo.name) ou título da sessão. */
  agent?: string;
  /** Pasta do projeto da sessão (o `cwd` do hook). */
  project?: string;
  /** Pasta pessoal do usuário (os.homedir()). Sem ela, é inferida de /Users/x, /home/x e C:\Users\x. */
  home?: string;
  /** Últimas atividades do agente (AgentInfo.recent), da mais antiga para a mais recente. */
  recent?: readonly Pick<Activity, 'text' | 'kind'>[];
}

type Rec = Record<string, unknown>;

/** Tamanho máximo das frases (o cartão mostra a explicação em destaque; o resto fica nos detalhes). */
export const PLAIN_WHAT_MAX = 240;
export const PLAIN_WHY_MAX = 160;

const ORDER: Record<PlainRisk, number> = { baixo: 0, medio: 1, alto: 2 };

/** O maior dos riscos. */
export function worstRisk(...risks: PlainRisk[]): PlainRisk {
  return risks.reduce((a, b) => (ORDER[b] > ORDER[a] ? b : a), 'baixo');
}

/** Rótulo do selo de risco ("Risco baixo", "Risco médio", "Risco alto"). */
export function riskLabel(risk: PlainRisk): string {
  return risk === 'alto' ? tr('Risco alto') : risk === 'medio' ? tr('Risco médio') : tr('Risco baixo');
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** Texto do agente (caminho, comando, descrição) que vai aparecer: mascarado e numa linha só. */
function safe(s: string, max = 80): string {
  return truncate(maskSecrets(s.slice(0, max * 8)), max);
}

function plain(risk: PlainRisk, what: string, why: string, context?: string): PlainExplanation {
  const out: PlainExplanation = { risk, what: truncate(maskSecrets(what), PLAIN_WHAT_MAX), why: truncate(maskSecrets(why), PLAIN_WHY_MAX) };
  if (context) out.context = truncate(maskSecrets(context), PLAIN_WHY_MAX);
  return out;
}

// ------------------------------------------------------------------ lugares

/** Onde um caminho cai, do ponto de vista de quem aprova. */
export type Zone = 'project' | 'claude' | 'codex' | 'habblaud' | 'temp' | 'secrets' | 'home' | 'system' | 'unknown';

export interface Place {
  zone: Zone;
  /** Com a preposição: "na pasta do projeto loja", "no caderno interno do Claude Code (~/.claude)"... */
  label: string;
  /** Sem a preposição, para "copiar X para a pasta do projeto loja". */
  noun: string;
}

const HOME_RE = /^(\/Users\/[^/]+|\/home\/[^/]+|\/root|[A-Za-z]:\/Users\/[^/]+)(?=\/|$)/;
const SECRETS_RE = /(^|\/)(\.ssh|\.aws|\.gnupg|\.gpg|\.kube|\.docker\/config\.json|\.netrc|\.npmrc|\.pypirc|\.git-credentials|\.env(\.[^/]+)?|credentials?(\.[^/]+)?|secrets?(\.[^/]+)?|id_(rsa|dsa|ecdsa|ed25519)[^/]*|[^/]*\.(pem|key|p12|pfx|keychain(-db)?))(\/|$)/i;
const TEMP_RE = /^(\/tmp|\/private\/tmp|\/var\/tmp|\/var\/folders|\/private\/var\/folders|[A-Za-z]:\/Users\/[^/]+\/AppData\/Local\/Temp)(\/|$)/i;
const SYSTEM_RE = /^(\/etc|\/usr|\/bin|\/sbin|\/opt|\/var|\/private|\/Library|\/System|\/Applications|\/boot|\/proc|\/dev|[A-Za-z]:\/(Windows|Program Files[^/]*))(\/|$)/i;

/** Pastas conhecidas da conta: [com a preposição, sem ela]. */
const HOME_FOLDERS: Record<string, () => [string, string]> = {
  Desktop: () => [tr('na sua Área de Trabalho'), tr('a sua Área de Trabalho')],
  Documents: () => [tr('na sua pasta Documentos'), tr('a sua pasta Documentos')],
  Downloads: () => [tr('na sua pasta Downloads'), tr('a sua pasta Downloads')],
  Pictures: () => [tr('na sua pasta Imagens'), tr('a sua pasta Imagens')],
  Movies: () => [tr('na sua pasta Vídeos'), tr('a sua pasta Vídeos')],
  Music: () => [tr('na sua pasta Músicas'), tr('a sua pasta Músicas')],
  Library: () => [tr('numa pasta interna da sua conta (Library)'), tr('uma pasta interna da sua conta (Library)')],
};

function at(zone: Zone, label: string, noun: string): Place {
  return { zone, label, noun };
}

/** Normaliza barras e `~`. */
function norm(path: string, home?: string): string {
  let p = path.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  if (p === '~' || p.startsWith('~/')) p = `${home ?? '~'}${p.slice(1)}`;
  if (home && p.startsWith('$HOME')) p = `${home}${p.slice(5)}`;
  return p;
}

/** Caminho relativo a `base` (sem a barra), ou undefined se não está dentro dela. */
function under(p: string, base: string | undefined): string | undefined {
  if (!base) return undefined;
  const b = base.replace(/\\/g, '/').replace(/\/+$/, '');
  if (!b) return undefined;
  if (p === b) return '';
  return p.startsWith(`${b}/`) ? p.slice(b.length + 1) : undefined;
}

/** Nome da pasta do projeto, para "no projeto X". */
export function projectName(project: string | undefined): string {
  return project ? basename(project.replace(/\\/g, '/')) || project : '';
}

/**
 * Descreve em palavras onde um caminho fica. Caminho relativo (sem `/` nem `~`) conta como dentro do projeto.
 * O rótulo já vem com a preposição ("na pasta do projeto X", "no caderno interno do Claude Code").
 */
export function describePlace(rawPath: string, ctx: ExplainContext): Place {
  const home = ctx.home ? norm(ctx.home) : undefined;
  const p = norm(rawPath, home);
  const project = ctx.project ? norm(ctx.project, home) : undefined;
  const name = projectName(project);
  const inProject = (rel: string): Place => {
    const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
    if (!name) return at('project', tr('na pasta do projeto'), tr('a pasta do projeto'));
    if (dir) return at('project', tr('na pasta {0} do projeto {1}', [safe(dir, 40), name]), tr('a pasta {0} do projeto {1}', [safe(dir, 40), name]));
    return at('project', tr('na pasta do projeto {0}', [name]), tr('a pasta do projeto {0}', [name]));
  };
  if (SECRETS_RE.test(p)) {
    const s = safe(shortHome(p, home), 40);
    return at('secrets', tr('nas suas chaves e senhas ({0})', [s]), tr('as suas chaves e senhas ({0})', [s]));
  }
  const rel = under(p, project);
  if (rel !== undefined) return inProject(rel);
  const isAbs = /^(\/|[A-Za-z]:\/)/.test(p);
  if (!isAbs) return inProject(p);
  if (TEMP_RE.test(p)) return at('temp', tr('numa pasta temporária do computador'), tr('uma pasta temporária do computador'));
  const h = home ?? HOME_RE.exec(p)?.[1];
  const inHome = under(p, h);
  if (inHome !== undefined) {
    const top = inHome.split('/')[0] ?? '';
    if (/^\.claude/.test(top)) return at('claude', tr('no caderno interno do Claude Code (~/{0})', [top]), tr('o caderno interno do Claude Code (~/{0})', [top]));
    if (/^\.codex/.test(top)) return at('codex', tr('no caderno interno do Codex (~/{0})', [top]), tr('o caderno interno do Codex (~/{0})', [top]));
    if (top === '.habblaud') return at('habblaud', tr('nas anotações do Habblaud (~/.habblaud)'), tr('as anotações do Habblaud (~/.habblaud)'));
    if (!top) return at('home', tr('na pasta pessoal da sua conta'), tr('a pasta pessoal da sua conta'));
    const known = HOME_FOLDERS[top];
    if (known) return at('home', ...known());
    return at('home', tr('na pasta {0} da sua conta, fora do projeto', [safe(top, 40)]), tr('a pasta {0} da sua conta, fora do projeto', [safe(top, 40)]));
  }
  if (SYSTEM_RE.test(p)) {
    const s = safe(p.split('/').slice(0, 2).join('/'), 30);
    return at('system', tr('numa pasta do sistema ({0})', [s]), tr('uma pasta do sistema ({0})', [s]));
  }
  const s = safe(shortHome(p, home), 50);
  return at('unknown', tr('fora do projeto ({0})', [s]), tr('fora do projeto ({0})', [s]));
}

/** "/Users/x/a/b" -> "~/a/b". */
function shortHome(p: string, home: string | undefined): string {
  const h = home ?? HOME_RE.exec(p)?.[1];
  return h && (p === h || p.startsWith(`${h}/`)) ? `~${p.slice(h.length)}` : p;
}

/** Risco de GRAVAR num lugar (ler é sempre baixo). */
function writeRisk(place: Place): PlainRisk {
  switch (place.zone) {
    case 'project':
    case 'claude':
    case 'codex':
    case 'habblaud':
    case 'temp':
      return 'baixo';
    case 'secrets':
    case 'system':
      return 'alto';
    default:
      return 'medio';
  }
}

/** Por que gravar ali tem esse risco. */
function writeWhy(place: Place, verb: string): string {
  switch (place.zone) {
    case 'project':
      return tr('Risco baixo: mexe só dentro do projeto, e o git guarda a versão anterior.');
    case 'claude':
    case 'codex':
      return tr('Risco baixo: é a pasta interna da ferramenta, não mexe nos seus projetos.');
    case 'habblaud':
      return tr('Risco baixo: só as anotações do Habblaud.');
    case 'temp':
      return tr('Risco baixo: pasta temporária, que o sistema limpa sozinho.');
    case 'secrets':
      return tr('Risco alto: mexe em senhas e chaves de acesso.');
    case 'system':
      return tr('Risco alto: {0} em pasta do sistema pode afetar o computador inteiro.', [verb]);
    default:
      return tr('Risco médio: {0} fora do projeto da sessão.', [verb]);
  }
}

/** Nome curto de um arquivo para a frase ("estado.json"; sem nome legível, "um arquivo"). */
function fileName(path: string): string {
  const name = basename(path.replace(/\\/g, '/'));
  return name && !name.includes('$') ? safe(name, 60) : '';
}

/** "o arquivo X" / "o arquivo X e mais N" (para comandos com vários alvos). */
function filesPhrase(paths: string[], folder = false): string {
  const names = paths.map(fileName).filter(Boolean);
  const noun = folder ? tr('a pasta') : tr('o arquivo');
  if (!names.length) return folder ? tr('uma pasta') : tr('um arquivo');
  if (names.length === 1) return `${noun} ${names[0]}`;
  if (names.length === 2) return tr('{0} {1} e {2}', [folder ? tr('as pastas') : tr('os arquivos'), names[0], names[1]]);
  return tr('{0} {1} e mais {2}', [folder ? tr('as pastas') : tr('os arquivos'), names[0], names.length - 1]);
}

// ------------------------------------------------------------------ comandos de terminal

interface Seg {
  /** Palavras do segmento, sem prefixos (sudo, env, nohup...). */
  words: string[];
  /** Programa (basename da primeira palavra). */
  prog: string;
  /** Rodava com sudo/doas. */
  sudo: boolean;
  /** Segmento que recebe um pipe de download (`curl … | sh`). */
  pipedFrom?: Seg;
  /** Arquivo que recebe a saída (`> arquivo`). */
  redirect?: string;
  /** Append (`>>`). */
  append?: boolean;
}

const WRAP = new Set(['env', 'time', 'nohup', 'exec', 'nice', 'caffeinate', 'stdbuf', 'unbuffer', 'command', 'builtin', 'timeout', 'gtimeout']);
const NOISE = new Set(['cd', 'pushd', 'popd', 'set', 'shopt', 'source', '.', 'true', 'false', ':', 'trap', 'ulimit', 'umask', 'clear', 'sleep', 'export', 'unset', 'local', 'readonly', 'do', 'done', 'then', 'fi', 'else', 'esac', 'wait', 'echo', 'printf']);
const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;
const SHELLS = new Set(['bash', 'sh', 'zsh', 'fish', 'dash', 'ksh']);

/** Separa um comando nos segmentos de nível superior, com sudo, pipes e redirecionamentos anotados. */
export function shellSegments(command: string, depth = 0): Seg[] {
  const out: Seg[] = [];
  const text = command.replace(/\\\r?\n/g, ' ').slice(0, 8_000);
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const segs = splitShell(line);
    let prev: Seg | undefined;
    let piped = false;
    for (let i = 0; i < segs.length; i++) {
      const segText = segs[i].replace(/^[({!]\s*/, '').replace(/\s*[)}]$/, '');
      // `|` entre segmentos: o splitShell não diz qual operador havia; reconstituímos olhando o texto original.
      const before = line.indexOf(segs[i]);
      const op = before > 0 ? line.slice(0, before).trimEnd().slice(-2) : '';
      piped = /(^|[^|])\|$/.test(op);
      const seg = parseSeg(segText);
      if (!seg) continue;
      if (piped && prev) seg.pipedFrom = prev;
      // `bash -c '…'`: olha dentro.
      if (SHELLS.has(seg.prog) && depth < 2) {
        const c = seg.words.indexOf('-c');
        if (c >= 0 && seg.words[c + 1]) {
          for (const inner of shellSegments(seg.words[c + 1], depth + 1)) out.push(seg.sudo ? { ...inner, sudo: true } : inner);
          prev = seg;
          continue;
        }
      }
      out.push(seg);
      prev = seg;
    }
  }
  return out;
}

function parseSeg(text: string): Seg | undefined {
  let words = shellWords(text);
  let sudo = false;
  let redirect: string | undefined;
  let append = false;
  // Redirecionamentos de saída.
  const clean: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const m = /^(\d*)(>>?)(.*)$/.exec(w);
    if (m && !/^\d*>&\d*$/.test(w)) {
      if (m[1] === '2') {
        if (!m[3]) i++;
        continue;
      }
      redirect = m[3] || words[++i];
      append = m[2] === '>>';
      continue;
    }
    if (/^(&>|&>>|<<?<?)$/.test(w)) {
      i++;
      continue;
    }
    if (/^(&>|<<?<?)/.test(w)) continue;
    clean.push(w);
  }
  words = clean;
  for (let guard = 0; guard < 12 && words.length; guard++) {
    const head = words[0];
    if (ASSIGN.test(head)) {
      words = words.slice(1);
      continue;
    }
    if (head === 'sudo' || head === 'doas') {
      sudo = true;
      let i = 1;
      while (i < words.length && words[i].startsWith('-')) i += /^-[ugpChU]$/.test(words[i]) ? 2 : 1;
      words = words.slice(i);
      continue;
    }
    if (WRAP.has(head) && words.length > 1) {
      let i = 1;
      if (head === 'timeout' || head === 'gtimeout') {
        while (i < words.length && words[i].startsWith('-')) i++;
        i++;
      } else while (i < words.length && words[i].startsWith('-') && words[i] !== '--') i += /^(-u|-n|-p|-a|-C|-S|--package|--unset|--chdir)$/.test(words[i]) ? 2 : 1;
      if (words[i] === '--') i++;
      words = words.slice(i);
      continue;
    }
    if ((head === 'npx' || head === 'bunx') && words.length > 1) {
      let i = 1;
      while (i < words.length && words[i].startsWith('-')) i += /^(-p|--package|-c|--call)$/.test(words[i]) ? 2 : 1;
      words = words.slice(i);
      continue;
    }
    break;
  }
  if (!words.length) return redirect ? { words: ['echo'], prog: 'echo', sudo, redirect, append } : undefined;
  const prog = basename(words[0]);
  if (NOISE.has(prog) && !redirect && !sudo) return undefined;
  return { words, prog, sudo, redirect, append };
}

/** Argumentos sem flags. */
function positional(words: string[]): string[] {
  const out: string[] = [];
  for (let i = 1; i < words.length; i++) {
    const w = words[i];
    if (w === '--') return [...out, ...words.slice(i + 1)];
    if (w.startsWith('-') && w.length > 1) continue;
    out.push(w);
  }
  return out;
}

function hasFlag(words: string[], ...flags: string[]): boolean {
  return words.slice(1).some((w) => flags.includes(w) || (/^-[a-zA-Z]+$/.test(w) && flags.some((f) => /^-[a-zA-Z]$/.test(f) && w.includes(f[1]))));
}

const PKG_INSTALL = /^(npm|pnpm|yarn|bun)$/;
const CLOUD = /^(kubectl|helm|terraform|aws|gcloud|az|flyctl|fly|vercel|wrangler|netlify|railway|heroku|supabase|firebase)$/;
const DB = /^(psql|mysql|mariadb|sqlite3|redis-cli|mongosh|mongo|duckdb)$/;
const READERS = /^(ls|find|tree|fd|du|df|eza|exa|cat|head|tail|less|more|bat|nl|wc|strings|xxd|od|hexdump|column|sort|uniq|cut|grep|rg|egrep|fgrep|ag|ack|awk|gawk|jq|yq|diff|cmp|comm|which|whereis|type|stat|file|md5|md5sum|shasum|sha256sum|realpath|readlink|pwd|date|env|printenv|ps|pgrep|top|htop|jobs|lsof|uname|hostname|whoami|id|uptime|tput|echo|printf|test|\[|basename|dirname|seq|xargs|tee)$/;
const DESTROY_SQL = /\b(drop\s+(table|database|schema|index|view)|truncate\s+table|truncate\b|delete\s+from|alter\s+table\s+\S+\s+drop)\b/i;
const WRITE_SQL = /\b(insert\s+into|update\s+\S+\s+set|alter\s+table|create\s+table)\b/i;
const EMAIL = /^(mail|mailx|sendmail|mutt|ssmtp|msmtp|swaks)$/;
const DESTROY_DISK = /^(mkfs(\.\w+)?|diskutil|dd|fdisk|parted|shred|wipefs|format)$/;
const POWER = /^(shutdown|reboot|halt|poweroff)$/;

interface CmdView {
  risk: PlainRisk;
  what: string;
  why: string;
}

const mk = (risk: PlainRisk, what: string, why: string): CmdView => ({ risk, what, why });

/** Descreve UM segmento de comando. */
function describeSeg(seg: Seg, ctx: ExplainContext, whole: string): CmdView {
  const { prog, words } = seg;
  const args = positional(words);
  const name = projectName(ctx.project);
  const inProjectWhy = name ? tr('Risco baixo: roda dentro do projeto {0}.', [name]) : tr('Risco baixo: roda dentro do projeto.');
  const place = (p: string) => describePlace(p, ctx);
  const text = words.join(' ');

  if (seg.sudo) {
    const inner = describeSeg({ ...seg, sudo: false }, ctx, whole);
    return mk('alto', tr('{0}, como administrador do computador (sudo)', [inner.what]), tr('Risco alto: com sudo o comando pode mudar qualquer coisa do sistema.'));
  }
  if (seg.pipedFrom && /^(curl|wget|fetch)$/.test(seg.pipedFrom.prog) && (SHELLS.has(prog) || /^(node|python3?|perl|ruby)$/.test(prog))) {
    return mk('alto', tr('baixar um programa da internet e executar na hora'), tr('Risco alto: roda código de fora sem ninguém conferir antes.'));
  }
  if (POWER.test(prog)) return mk('alto', tr('desligar ou reiniciar o computador'), tr('Risco alto: fecha tudo que está aberto.'));
  if (DESTROY_DISK.test(prog)) return mk('alto', tr('mexer direto no disco ({0})', [prog]), tr('Risco alto: pode apagar dados do disco inteiro.'));
  if (EMAIL.test(prog)) return mk('alto', tr('mandar um e-mail'), tr('Risco alto: sai uma mensagem em seu nome.'));
  if (prog === 'osascript' && /(send|mail|messages|imessage)/i.test(text)) return mk('alto', tr('mandar uma mensagem por um aplicativo do Mac'), tr('Risco alto: sai uma mensagem em seu nome.'));

  if (prog === 'rm') {
    const recursive = hasFlag(words, '-r', '-R', '--recursive');
    const targets = args;
    const places = targets.map(place);
    const worst = places.some((p) => p.zone === 'secrets' || p.zone === 'system' || p.zone === 'home' || p.zone === 'unknown');
    const where = places[0]?.label ?? '';
    const what = recursive ? tr('apagar {0} e tudo que há dentro, {1}', [filesPhrase(targets, true), where]) : tr('apagar {0} {1}', [filesPhrase(targets), where]);
    const why = worst ? tr('Risco alto: apaga fora do projeto, e não dá para desfazer.') : tr('Risco alto: apagar não dá para desfazer (fora do git).');
    return mk('alto', what, why);
  }
  if (prog === 'git') {
    let i = 1;
    while (i < words.length && words[i].startsWith('-')) i += words[i] === '-C' || words[i] === '-c' ? 2 : 1;
    const sub = words[i] ?? '';
    const rest = words.slice(i + 1);
    const force = rest.some((w) => w === '-f' || w === '--force' || w.startsWith('--force-with-lease') || w === '-D');
    switch (sub) {
      case 'status':
      case 'diff':
      case 'log':
      case 'show':
      case 'blame':
      case 'branch':
        if (sub === 'branch' && force) return mk('alto', tr('apagar uma branch do git à força'), tr('Risco alto: commits só daquela branch podem se perder.'));
        if (sub === 'branch' && rest.some((w) => w === '-d' || w === '--delete')) return mk('medio', tr('apagar uma branch já incorporada do git'), tr('Risco médio: o git só deixa apagar branch já mesclada.'));
        return mk('baixo', tr('conferir o histórico ou as mudanças no git (só leitura)'), tr('Risco baixo: só leitura, não muda nada.'));
      case 'add':
        return mk('baixo', tr('preparar arquivos para o próximo commit (git add)'), tr('Risco baixo: não muda o conteúdo dos arquivos.'));
      case 'commit':
        return mk('medio', tr('salvar as mudanças no histórico do git (commit)'), tr('Risco médio: entra no histórico do código, mas dá para voltar.'));
      case 'push':
        if (force) return mk('alto', tr('sobrescrever o histórico no servidor do código (force push)'), tr('Risco alto: pode apagar commits de outras pessoas.'));
        return mk('medio', tr('enviar os commits para o servidor do código (git push)'), tr('Risco médio: o código sai do computador e vai para o repositório remoto.'));
      case 'pull':
      case 'fetch':
        return mk('medio', tr('baixar as atualizações do repositório remoto (git {0})', [sub]), tr('Risco médio: acessa a rede e pode mudar arquivos do projeto.'));
      case 'clone':
        return mk('medio', tr('baixar um repositório da internet (git clone)'), tr('Risco médio: acessa a rede e cria uma pasta nova.'));
      case 'reset':
        if (rest.includes('--hard')) return mk('alto', tr('descartar as mudanças não salvas do projeto (git reset --hard)'), tr('Risco alto: o que não estava em commit se perde.'));
        return mk('medio', tr('desfazer um passo do git (reset)'), tr('Risco médio: mexe no estado do git, mas sem apagar arquivos.'));
      case 'clean':
        return mk('alto', tr('apagar os arquivos que o git não controla (git clean)'), tr('Risco alto: apaga arquivos novos que ainda não foram salvos no git.'));
      case 'checkout':
      case 'switch':
      case 'restore':
        if (sub === 'restore' || rest.includes('--') || rest.includes('.')) return mk('medio', tr('voltar arquivos à última versão salva no git'), tr('Risco médio: mudanças não salvas nesses arquivos se perdem.'));
        return mk('baixo', tr('trocar de branch no git'), tr('Risco baixo: só muda qual versão está aberta.'));
      case 'merge':
      case 'rebase':
      case 'cherry-pick':
        return mk('medio', tr('juntar mudanças de outra branch (git {0})', [sub]), tr('Risco médio: muda o histórico local; pode dar conflito.'));
      case 'stash':
        return mk('medio', tr('guardar as mudanças de lado (git stash)'), tr('Risco médio: as mudanças somem da tela, mas ficam guardadas.'));
      case 'tag':
      case 'remote':
      case 'worktree':
      case 'config':
        return mk('medio', tr('mudar a configuração do git ({0})', [sub]), tr('Risco médio: afeta o repositório, não os seus arquivos.'));
      default:
        return mk('medio', sub ? tr('usar o git ({0})', [safe(sub, 20)]) : tr('usar o git'), tr('Risco médio: comando do git não reconhecido.'));
    }
  }
  if (prog === 'gh') {
    const sub = `${args[0] ?? ''} ${args[1] ?? ''}`.trim();
    if (/^(repo delete|api)/.test(sub) && (/delete/.test(sub) || /-X\s+DELETE|--method\s+DELETE/i.test(text))) return mk('alto', tr('apagar algo no GitHub ({0})', [safe(sub, 30)]), tr('Risco alto: apaga no GitHub, fora do computador.'));
    if (/\b(view|list|status|diff|checks)\b/.test(sub) || /^(auth status|pr view|issue view|run view)/.test(sub)) return mk('baixo', tr('consultar o GitHub ({0})', [safe(sub, 30)]), tr('Risco baixo: só leitura.'));
    if (/^(pr merge)/.test(sub)) return mk('alto', tr('fazer o merge de um pull request no GitHub'), tr('Risco alto: muda o código principal do repositório.'));
    return mk('medio', tr('publicar algo no GitHub ({0})', [safe(sub, 30)]), tr('Risco médio: cria ou altera algo no GitHub, em seu nome.'));
  }
  if (/\b(vitest|jest|pytest|phpunit|mocha|ava|rspec)\b|\b(go|cargo|deno|bun)\s+test\b|playwright\s+test|\b(npm|pnpm|yarn|bun)\s+(run\s+)?test\b|\bnode\s+--test\b/.test(text)) {
    return mk('baixo', tr('rodar os testes automáticos do projeto'), inProjectWhy);
  }
  if (PKG_INSTALL.test(prog) && /^(i|install|add|ci|up|update|upgrade)$/.test(args[0] ?? '')) {
    const global = words.some((w) => w === '-g' || w === '--global');
    if (global) return mk('medio', tr('instalar um programa no computador inteiro ({0} -g)', [prog]), tr('Risco médio: instala fora do projeto, para todos os projetos.'));
    return mk('medio', args[1] ? tr('instalar a biblioteca {0} no projeto', [safe(args[1], 40)]) : tr('instalar as bibliotecas que o projeto usa'), tr('Risco médio: baixa código da internet para o projeto.'));
  }
  if (/^(pip3?|pipx|uv|poetry|cargo|gem|composer|go)$/.test(prog) && /^(install|add|get|sync|require)$/.test(args[0] ?? '')) {
    return mk('medio', tr('instalar bibliotecas ({0})', [prog]), tr('Risco médio: baixa código da internet.'));
  }
  if (prog === 'brew' || prog === 'apt' || prog === 'apt-get' || prog === 'dnf' || prog === 'yum' || prog === 'pacman' || prog === 'port') {
    if (/^(install|upgrade|update|reinstall)$/.test(args[0] ?? '')) return mk('medio', tr('instalar ou atualizar um programa no computador ({0})', [prog]), tr('Risco médio: muda os programas do computador.'));
    if (/^(uninstall|remove|purge)$/.test(args[0] ?? '')) return mk('alto', tr('desinstalar um programa do computador ({0})', [prog]), tr('Risco alto: remove um programa do computador.'));
    return mk('baixo', tr('consultar o gerenciador de programas ({0})', [prog]), tr('Risco baixo: só consulta.'));
  }
  if (PKG_INSTALL.test(prog) && /^(run|exec|x)$/.test(args[0] ?? '') && args[1]) {
    const script = args[1];
    if (/^(build|compile)$/.test(script)) return mk('baixo', tr('compilar (montar) o projeto'), inProjectWhy);
    if (/^(typecheck|type-check|check-types|lint|format|check)$/.test(script)) return mk('baixo', tr('conferir o código do projeto ({0})', [script]), inProjectWhy);
    if (/^(dev|start|serve|preview)$/.test(script)) return mk('baixo', tr('subir o servidor local do projeto para testar'), inProjectWhy);
    if (/^(deploy|publish|release)$/.test(script)) return mk('alto', tr('publicar o projeto ({0} {1})', [prog, script]), tr('Risco alto: põe uma versão nova no ar, para quem usa.'));
    return mk('baixo', tr('rodar o script {0} do projeto', [safe(script, 30)]), inProjectWhy);
  }
  if (PKG_INSTALL.test(prog) && /^(publish)$/.test(args[0] ?? '')) return mk('alto', tr('publicar o pacote na internet ({0} publish)', [prog]), tr('Risco alto: sai do computador para todo mundo.'));
  if (PKG_INSTALL.test(prog) && /^(build|start|dev|lint|typecheck)$/.test(args[0] ?? '')) return mk('baixo', tr('rodar o script {0} do projeto', [args[0]]), inProjectWhy);
  if (/^(tsc|vite|webpack|esbuild|rollup|make|gradle|mvn)$/.test(prog) || (prog === 'cargo' && args[0] === 'build') || (prog === 'go' && args[0] === 'build')) return mk('baixo', tr('compilar (montar) o projeto'), inProjectWhy);
  if (/^(eslint|prettier|ruff|black|biome|rubocop|stylelint|oxlint)$/.test(prog)) return mk('baixo', tr('conferir e arrumar o estilo do código'), inProjectWhy);
  if (prog === 'docker' || prog === 'docker-compose' || prog === 'podman') {
    if (/^(rm|rmi|prune|system)$/.test(args[0] ?? '') || /\bprune\b/.test(text)) return mk('alto', tr('apagar containers ou imagens do Docker'), tr('Risco alto: apaga, e não dá para desfazer.'));
    if (/^(ps|logs|images|inspect|version|info)$/.test(args[0] ?? '')) return mk('baixo', tr('consultar o Docker'), tr('Risco baixo: só leitura.'));
    return mk('medio', tr('mexer nos containers do Docker ({0})', [safe(args.slice(0, 2).join(' '), 30)]), tr('Risco médio: sobe, para ou muda programas em containers.'));
  }
  if (CLOUD.test(prog)) {
    if (/\b(delete|destroy|rm|remove|teardown)\b/.test(text)) return mk('alto', tr('apagar algo na nuvem ({0})', [prog]), tr('Risco alto: apaga recursos na nuvem, que podem custar dinheiro para refazer.'));
    if (/\b(get|list|describe|ls|status|plan|show|logs|whoami)\b/.test(text)) return mk('baixo', tr('consultar a nuvem ({0})', [prog]), tr('Risco baixo: só consulta.'));
    return mk('alto', tr('mudar algo na nuvem ({0})', [prog]), tr('Risco alto: mexe em serviços no ar, e pode gerar custo.'));
  }
  if (/^(curl|wget|http|https|xh|fetch)$/.test(prog)) {
    const url = args.find((a) => /^(https?:\/\/|localhost|\d+\.\d+\.\d+\.\d+|[\w-]+(\.[\w-]+)+)/i.test(a)) ?? '';
    let host = '';
    try {
      host = new URL(/^https?:\/\//i.test(url) ? url : `http://${url}`).hostname.replace(/^www\./, '');
    } catch {
      host = '';
    }
    const local = !host || host === 'localhost' || host === '::1' || /^127\./.test(host) || host === '0.0.0.0';
    const sends = /(^|\s)(-X\s*(POST|PUT|PATCH|DELETE)|--request\s+\S+|-d\b|--data\b|--json\b|-F\b|--form\b|-T\b|--upload-file\b)/i.test(text);
    if (local) return mk('baixo', tr('testar o servidor que roda neste computador'), tr('Risco baixo: não sai do computador.'));
    if (/-X\s*DELETE|--request\s+DELETE/i.test(text)) return mk('alto', tr('apagar algo no site {0} pela internet', [host]), tr('Risco alto: apaga em outro serviço.'));
    if (sends) return mk('medio', tr('mandar dados para o site {0}', [host]), tr('Risco médio: informações saem do computador pela internet.'));
    if (seg.redirect || hasFlag(words, '-o', '-O', '--output')) return mk('medio', tr('baixar um arquivo do site {0}', [host]), tr('Risco médio: traz um arquivo da internet.'));
    return mk('medio', tr('acessar o site {0} pela internet', [host]), tr('Risco médio: acessa a internet (só leitura).'));
  }
  if (/^(ssh|scp|sftp|rsync|telnet|nc|ncat)$/.test(prog) && (prog !== 'rsync' || /@|:/.test(args.join(' ')))) {
    return mk('medio', tr('conectar em outro computador pela rede ({0})', [prog]), tr('Risco médio: acessa outra máquina em seu nome.'));
  }
  if (DB.test(prog)) {
    if (DESTROY_SQL.test(whole)) return mk('alto', tr('apagar dados ou tabelas do banco de dados'), tr('Risco alto: dados apagados não voltam.'));
    if (WRITE_SQL.test(whole)) return mk('medio', tr('gravar ou alterar dados no banco de dados'), tr('Risco médio: muda dados guardados.'));
    return mk('baixo', tr('consultar o banco de dados'), tr('Risco baixo: só consulta.'));
  }
  if (/^(kill|pkill|killall)$/.test(prog)) return mk('medio', tr('encerrar um programa que está rodando'), tr('Risco médio: o programa fecha sem salvar.'));
  if (/^(launchctl|systemctl|service|brew\s+services)$/.test(prog)) return mk('medio', tr('ligar, parar ou mudar um serviço do sistema ({0})', [prog]), tr('Risco médio: mexe em programas que rodam sozinhos no computador.'));
  if (prog === 'defaults' || prog === 'security' || prog === 'scutil' || prog === 'networksetup' || prog === 'csrutil' || prog === 'spctl') return mk('alto', tr('mudar configurações do computador ({0})', [prog]), tr('Risco alto: mexe nas configurações ou nas chaves do sistema.'));
  if (prog === 'crontab' && !hasFlag(words, '-l')) return mk('medio', tr('agendar tarefas que rodam sozinhas (crontab)'), tr('Risco médio: algo passa a rodar sem você pedir.'));
  if (/^(chmod|chown|chgrp)$/.test(prog)) {
    const targets = args.slice(1);
    const bad = targets.some((t) => t === '/' || describePlace(t, ctx).zone === 'system') || hasFlag(words, '-R') && targets.some((t) => describePlace(t, ctx).zone !== 'project');
    return bad ? mk('alto', tr('mudar as permissões de pastas importantes do sistema'), tr('Risco alto: pode travar programas do computador.')) : mk('medio', tr('mudar as permissões de {0}', [filesPhrase(targets)]), tr('Risco médio: muda quem pode abrir ou rodar o arquivo.'));
  }
  if (prog === 'cp' || prog === 'mv' || prog === 'ln' || prog === 'rsync') {
    const dest = args[args.length - 1];
    const srcs = args.slice(0, -1);
    const to = dest ? describePlace(dest, ctx) : at('unknown', '', '');
    const from = srcs.map((s) => describePlace(s, ctx));
    const risk = worstRisk(writeRisk(to), ...(prog === 'mv' ? from.map(writeRisk) : []), ...from.map((f) => (f.zone === 'secrets' ? 'alto' : 'baixo') as PlainRisk));
    const verb = prog === 'cp' || prog === 'rsync' ? tr('copiar') : prog === 'ln' ? tr('criar um atalho para') : tr('mover');
    const what = srcs.length ? tr('{0} {1} para {2}', [verb, filesPhrase(srcs), to.noun]) : tr('{0} arquivos para {1}', [verb, to.noun]);
    const why = prog === 'mv' && from.some((f) => f.zone !== 'project') ? tr('Risco médio: tira o arquivo de onde estava.') : to.zone === 'project' ? tr('Risco baixo: cria um arquivo novo no projeto.') : writeWhy(to, tr('gravar'));
    return mk(risk, what, risk === 'alto' ? tr('Risco alto: mexe em chaves, senhas ou pastas do sistema.') : why);
  }
  if (prog === 'mkdir') {
    const p = args[0] ? describePlace(args[0], ctx) : undefined;
    return mk(p ? writeRisk(p) : 'medio', tr('criar {0} {1}', [filesPhrase(args, true), p?.label ?? '']), p ? writeWhy(p, tr('criar pasta')) : tr('Risco médio: cria uma pasta.'));
  }
  if (prog === 'touch') {
    const p = args[0] ? describePlace(args[0], ctx) : undefined;
    return mk(p ? writeRisk(p) : 'medio', tr('criar {0} vazio {1}', [filesPhrase(args), p?.label ?? '']), p ? writeWhy(p, tr('criar arquivo')) : tr('Risco médio: cria um arquivo.'));
  }
  if (/^(sed|gsed|perl)$/.test(prog) && words.some((w) => /^-i|^--in-place|^-pi/.test(w))) {
    const target = args[args.length - 1];
    const p = target && /[./]/.test(target) ? describePlace(target, ctx) : undefined;
    return mk(p ? writeRisk(p) : 'medio', p ? tr('alterar {0} {1} por um comando', [filesPhrase([target]), p.label]) : tr('alterar um arquivo por um comando'), p ? writeWhy(p, tr('editar')) : tr('Risco médio: edita um arquivo.'));
  }
  if (seg.redirect && seg.redirect !== '/dev/null') {
    const p = describePlace(seg.redirect, ctx);
    const name = fileName(seg.redirect);
    const what = seg.append
      ? tr('acrescentar texto no fim do arquivo {0} {1}', [name || tr('indicado'), p.label])
      : tr('gravar {0} {1}', [filesPhrase([seg.redirect]), p.label]);
    return mk(writeRisk(p), what, writeWhy(p, tr('gravar')));
  }
  if (prog === 'tee') {
    const target = args[0];
    const p = target ? describePlace(target, ctx) : undefined;
    return mk(p ? writeRisk(p) : 'medio', p ? tr('gravar {0} {1}', [filesPhrase([target]), p.label]) : tr('gravar um arquivo'), p ? writeWhy(p, tr('gravar')) : tr('Risco médio: grava um arquivo.'));
  }
  if (/^(tar|zip|unzip|gzip|gunzip|xz|7z)$/.test(prog)) return mk('medio', tr('compactar ou descompactar arquivos ({0})', [prog]), tr('Risco médio: cria arquivos novos.'));
  if (prog === 'open' || prog === 'xdg-open' || prog === 'start') return mk('medio', tr('abrir algo no computador (programa, arquivo ou página)'), tr('Risco médio: abre uma janela fora do terminal.'));
  if (/^(code|cursor|subl|vim|nvim|nano|emacs)$/.test(prog)) return mk('baixo', tr('abrir um arquivo no editor'), tr('Risco baixo: só abre.'));
  if (/^(pbcopy|pbpaste|xclip|xsel)$/.test(prog)) return mk('baixo', tr('usar a área de transferência (copiar e colar)'), tr('Risco baixo.'));
  if (prog === 'claude' || prog === 'codex') return mk('medio', tr('abrir outro agente ({0}) pelo terminal', [prog]), tr('Risco médio: o outro agente trabalha com as próprias permissões.'));
  if (READERS.test(prog)) {
    if (prog === 'xargs' && /\b(rm|mv)\b/.test(text)) return mk('alto', tr('apagar ou mover vários arquivos de uma vez'), tr('Risco alto: apaga ou move em lote.'));
    return mk('baixo', tr('ler ou conferir arquivos e informações no terminal'), tr('Risco baixo: só leitura, não muda nada.'));
  }
  if (/^(node|python3?|ruby|php|deno|bun|tsx|ts-node|perl|java)$/.test(prog) || (prog === 'go' && args[0] === 'run')) {
    const script = args.find((a) => /[./]/.test(a) && !/^\d+(\.\d+)*$/.test(a));
    if (script) {
      const p = describePlace(script, ctx);
      const ok = p.zone === 'project' || p.zone === 'temp' || p.zone === 'claude' || p.zone === 'habblaud';
      return mk(ok ? 'baixo' : 'medio', tr('executar o script {0} {1}', [fileName(script) || safe(script, 40), p.label]), ok ? tr('Risco baixo: script do próprio projeto.') : tr('Risco médio: script de fora do projeto.'));
    }
    return mk('medio', tr('executar um trecho de código ({0}) no terminal', [prog]), tr('Risco médio: código escrito na hora; os detalhes técnicos mostram o que faz.'));
  }
  if (/^(\.{0,2}\/|~\/)/.test(words[0]) || /\.(sh|bash|zsh|py|rb|mjs|js|ts)$/.test(words[0])) {
    const p = describePlace(words[0], ctx);
    return mk(p.zone === 'project' ? 'baixo' : 'medio', tr('executar o script {0} {1}', [fileName(words[0]) || prog, p.label]), p.zone === 'project' ? tr('Risco baixo: script do próprio projeto.') : tr('Risco médio: script de fora do projeto.'));
  }
  return mk('medio', tr('rodar o programa {0} no terminal', [safe(prog, 24)]), tr('Risco médio: comando que o Habblaud não reconhece; veja os detalhes técnicos.'));
}

const VERBS_EN: Record<string, string> = {
  run: 'rodar', runs: 'rodar', running: 'rodando', execute: 'executar', list: 'listar', show: 'mostrar', display: 'mostrar', print: 'mostrar', check: 'conferir', verify: 'verificar', inspect: 'inspecionar',
  install: 'instalar', remove: 'remover', delete: 'apagar', clean: 'limpar', create: 'criar', make: 'criar', add: 'adicionar', update: 'atualizar', upgrade: 'atualizar', build: 'compilar', compile: 'compilar',
  test: 'testar', start: 'iniciar', stop: 'parar', restart: 'reiniciar', kill: 'encerrar', read: 'ler', view: 'ver', find: 'procurar', search: 'procurar', count: 'contar', copy: 'copiar', move: 'mover',
  rename: 'renomear', push: 'enviar', pull: 'baixar', fetch: 'baixar', download: 'baixar', upload: 'subir', open: 'abrir', write: 'gravar', save: 'salvar', edit: 'editar', change: 'mudar', set: 'definir',
  compare: 'comparar', clone: 'clonar', commit: 'fazer commit de', publish: 'publicar', deploy: 'publicar', send: 'enviar', get: 'obter', generate: 'gerar', format: 'formatar', lint: 'conferir o estilo de',
  wait: 'esperar', watch: 'acompanhar', monitor: 'monitorar', tail: 'acompanhar', grep: 'buscar', look: 'olhar', confirm: 'confirmar', ensure: 'garantir', apply: 'aplicar', revert: 'reverter', reset: 'zerar',
  rebuild: 'recompilar', reinstall: 'reinstalar', sync: 'sincronizar', merge: 'juntar', switch: 'trocar', squash: 'juntar', stage: 'preparar', unstage: 'despreparar', stash: 'guardar', capture: 'capturar',
  screenshot: 'capturar a tela', record: 'gravar', convert: 'converter', extract: 'extrair', unzip: 'descompactar', zip: 'compactar', archive: 'arquivar', backup: 'fazer backup de', restore: 'restaurar',
  query: 'consultar', select: 'selecionar', insert: 'inserir', drop: 'apagar', truncate: 'esvaziar', migrate: 'migrar', seed: 'popular', serve: 'servir', preview: 'pré-visualizar', launch: 'abrir',
  attach: 'anexar', detach: 'soltar', enable: 'ligar', disable: 'desligar', configure: 'configurar', setup: 'preparar', initialize: 'iniciar', init: 'iniciar', register: 'registrar', login: 'entrar',
  logout: 'sair', authenticate: 'autenticar', validate: 'validar', analyze: 'analisar', analyse: 'analisar', summarize: 'resumir', report: 'relatar', scan: 'varrer', probe: 'sondar', ping: 'testar', call: 'chamar',
  invoke: 'chamar', trigger: 'disparar', schedule: 'agendar', cancel: 'cancelar', retry: 'tentar de novo', fix: 'corrigir', patch: 'corrigir', replace: 'substituir', append: 'acrescentar', prepend: 'acrescentar no início',
  echo: 'mostrar', cat: 'mostrar', dump: 'despejar', export: 'exportar', import: 'importar', load: 'carregar', unload: 'descarregar', mount: 'montar', unmount: 'desmontar', free: 'liberar', release: 'liberar',
};

/** Descrição que o agente mandou no `description` do Bash, em palavras do leigo. */
export function agentSays(description: string | undefined): string | undefined {
  const d = description?.trim();
  if (!d) return undefined;
  const shown = safe(d, 120);
  if (looksPortugueseLite(d)) return tr('O agente descreve: “{0}”.', [shown]);
  const first = /^[A-Za-z]+/.exec(d)?.[0].toLowerCase() ?? '';
  const verb = VERBS_EN[first];
  return verb ? tr('O agente descreve (em inglês): “{0}” — ou seja, {1}…', [shown, verb]) : tr('O agente descreve (em inglês): “{0}”.', [shown]);
}

/** Versão leve de activity.looksPortuguese (sem importar a pesada). */
function looksPortugueseLite(s: string): boolean {
  const pt = (s.match(/\b(de|da|do|das|dos|para|pra|com|em|no|na|nos|nas|um|uma|os|as|que|por|sem|ao|aos|pelo|pela|e|o)\b/gi) ?? []).length;
  const accents = (s.match(/[ãõçáéíóúâêôà]/gi) ?? []).length;
  const en = (s.match(/\b(the|of|to|for|with|and|in|on|from|an|by|into|all|its|is|are|run|check|start|stop|show|list|get|read|count|find|kill|build|test|verify|wait|open|print|fetch|install|update|create|remove|screenshot)\b/gi) ?? []).length;
  return pt + accents * 2 > en;
}

/** Explica um comando de terminal inteiro: o risco é o pior entre os segmentos; a frase vem do primeiro "de verdade". */
export function explainCommand(command: string, description: string | undefined, ctx: ExplainContext): PlainExplanation {
  const text = command.trim();
  let segs: Seg[] = [];
  try {
    segs = shellSegments(text);
  } catch {
    segs = [];
  }
  const says = agentSays(description);
  if (!segs.length) {
    const what = tr('O agente quer rodar um comando no terminal.');
    return plain('medio', says ? `${what} ${says}` : what, tr('Risco médio: o Habblaud não conseguiu ler o comando; veja os detalhes técnicos.'));
  }
  // `curl … | sh`: o download faz parte do "baixar e executar"; não conta como outro comando.
  const feeders = new Set(segs.map((s) => (s.pipedFrom && /^(curl|wget|fetch)$/.test(s.pipedFrom.prog) && (SHELLS.has(s.prog) || /^(node|python3?|perl|ruby)$/.test(s.prog)) ? s.pipedFrom : undefined)).filter(Boolean));
  const views = segs.filter((s) => !feeders.has(s)).map((s) => describeSeg(s, ctx, text));
  const risk = worstRisk(...views.map((v) => v.risk));
  // A frase do segmento de maior risco; empate, o primeiro.
  const main = views.find((v) => v.risk === risk) ?? views[0];
  const others = views.filter((v) => v !== main && v.what !== main.what);
  let what = tr('O agente quer {0}.', [main.what]);
  if (others.length === 1) what = tr('O agente quer {0}, e também {1}.', [main.what, others[0].what]);
  else if (others.length > 1) what = tr('O agente quer {0} (e mais {1} comandos).', [main.what, others.length]);
  if (says) what = `${what} ${says}`;
  return plain(risk, what, main.why);
}

// ------------------------------------------------------------------ ferramentas

/** Nome legível de um servidor MCP ("claude_ai_Gmail" -> "Gmail"). */
function mcpParts(name: string): { server: string; tool: string } {
  const [, server = '', ...rest] = name.split('__');
  return { server: server.replace(/^claude_ai_/, '').replace(/[_-]+/g, ' '), tool: rest.join('__').replace(/[_-]+/g, ' ') };
}

function explainMcp(name: string, input: Rec): PlainExplanation {
  const { server, tool } = mcpParts(name);
  const t = tool.toLowerCase();
  const s = server.toLowerCase();
  const srv = server || tr('um serviço externo');
  if (/\b(send|reply|forward|post|publish|tweet|dm|message|mail|notify)\b/.test(t) && !/\b(get|list|read|search|fetch|draft)\b/.test(t)) {
    return plain('alto', tr('O agente quer enviar uma mensagem ou publicar algo pelo serviço {0} ({1}).', [srv, tool]), tr('Risco alto: sai algo em seu nome para outras pessoas.'));
  }
  if (/\b(pay|payment|transfer|purchase|buy|order|charge|refund|invoice)\b/.test(t)) {
    return plain('alto', tr('O agente quer fazer uma operação com dinheiro pelo serviço {0} ({1}).', [srv, tool]), tr('Risco alto: envolve dinheiro.'));
  }
  if (/\b(delete|remove|drop|destroy|purge|trash|truncate|reset|wipe)\b/.test(t) || (/sql|query|execute/.test(t) && DESTROY_SQL.test(JSON.stringify(input)))) {
    return plain('alto', tr('O agente quer apagar algo no serviço {0} ({1}).', [srv, tool]), tr('Risco alto: apaga dados fora do computador.'));
  }
  if (/playwright|chrome|browser|puppeteer/.test(s)) {
    if (/\b(navigate|screenshot|read|snapshot|find|get|text|console|network|tabs context|list)\b/.test(t)) return plain('baixo', tr('O agente quer olhar uma página no navegador ({0}).', [tool]), tr('Risco baixo: só olha a página.'));
    return plain('medio', tr('O agente quer agir numa página do navegador ({0}): clicar, digitar ou preencher.', [tool]), tr('Risco médio: age num site em seu nome.'));
  }
  if (/\b(get|list|read|search|fetch|query|find|describe|show|lookup|check|status|count|view|whoami|info)\b/.test(t) && !/\b(create|update|write|set|insert|upsert|apply|modify|edit|rename|move)\b/.test(t)) {
    return plain('baixo', tr('O agente quer consultar o serviço {0} ({1}).', [srv, tool]), tr('Risco baixo: só leitura, não muda nada lá.'));
  }
  return plain('medio', tr('O agente quer criar ou alterar algo no serviço {0} ({1}).', [srv, tool]), tr('Risco médio: muda dados fora do computador.'));
}

/** O contexto para a explicação: o que o agente fazia logo antes. */
function recentContext(ctx: ExplainContext): string | undefined {
  const last = ctx.recent?.filter((a) => a.text && a.kind !== 'wait' && a.kind !== 'ask' && a.kind !== 'think').slice(-1)[0];
  return last ? tr('Logo antes, o agente estava: {0}.', [last.text.replace(/[.…]+$/, '').toLowerCase()]) : undefined;
}

/** Arquivos de um patch do apply_patch (Codex). */
function patchFiles(patch: string): Array<{ op: string; path: string }> {
  return [...patch.slice(0, 200_000).matchAll(/^\*\*\* (Add|Update|Delete) File: (.+)$/gm)].map((m) => ({ op: m[1], path: m[2].trim() }));
}

/**
 * Explica um pedido de permissão para quem não é programador: o que o agente quer fazer, onde, e o risco de
 * aprovar. undefined = a ferramenta não precisa de explicação (AskUserQuestion: o cartão já mostra as perguntas).
 * Nunca lança: qualquer entrada estranha vira uma explicação genérica de risco médio.
 */
export function explainForLayperson(tool: string, rawInput: unknown, ctx: ExplainContext = {}): PlainExplanation | undefined {
  try {
    return explain(tool, rawInput, ctx);
  } catch {
    return plain('medio', tr('O agente quer usar a ferramenta {0}.', [safe(tool, 40)]), tr('Risco médio: o Habblaud não conseguiu ler o pedido; veja os detalhes técnicos.'));
  }
}

function explain(tool: string, rawInput: unknown, ctx: ExplainContext): PlainExplanation | undefined {
  const input = (rawInput && typeof rawInput === 'object' ? rawInput : {}) as Rec;
  const file = str(input.file_path) || str(input.notebook_path) || str(input.path);
  const context = recentContext(ctx);
  const withCtx = (p: PlainExplanation): PlainExplanation => (context ? { ...p, context } : p);
  const place = file ? describePlace(file, ctx) : undefined;
  const fname = file ? fileName(file) : '';

  switch (tool) {
    case 'AskUserQuestion':
      return undefined;
    case 'Read':
    case 'LS':
    case 'Glob':
    case 'Grep': {
      if (tool === 'Read' && place) return withCtx(plain(place.zone === 'secrets' ? 'medio' : 'baixo', tr('O agente quer ler {0}, {1}.', [fname ? tr('o arquivo {0}', [fname]) : tr('um arquivo'), place.label]), place.zone === 'secrets' ? tr('Risco médio: o arquivo pode ter senhas ou chaves; ler não muda nada, mas o agente passa a conhecê-las.') : tr('Risco baixo: só leitura, não muda nada.')));
      const where = place ? ` ${place.label}` : '';
      return withCtx(plain('baixo', tr('O agente quer procurar arquivos ou trechos de código{0}.', [where]), tr('Risco baixo: só leitura, não muda nada.')));
    }
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit': {
      if (!place) return withCtx(plain('medio', tr('O agente quer alterar um arquivo.'), tr('Risco médio: o Habblaud não sabe qual arquivo.')));
      const risk = writeRisk(place);
      return withCtx(plain(risk, tr('O agente quer alterar {0} {1}.', [fname ? tr('o arquivo {0}', [fname]) : tr('um arquivo'), place.label]), writeWhy(place, tr('editar'))));
    }
    case 'Write': {
      if (!place) return withCtx(plain('medio', tr('O agente quer gravar um arquivo.'), tr('Risco médio: o Habblaud não sabe qual arquivo.')));
      const risk = writeRisk(place);
      return withCtx(plain(risk, tr('O agente quer gravar {0} {1} (cria ou substitui o conteúdo).', [fname ? tr('o arquivo {0}', [fname]) : tr('um arquivo'), place.label]), writeWhy(place, tr('gravar'))));
    }
    case 'Bash':
      return withCtx(explainCommand(str(input.command), str(input.description) || undefined, ctx));
    case 'BashOutput':
    case 'TaskOutput':
    case 'Monitor':
    case 'KillShell':
    case 'KillBash':
    case 'TaskStop':
      return withCtx(plain('baixo', tool.startsWith('Kill') || tool === 'TaskStop' ? tr('O agente quer parar um comando que ele mesmo deixou rodando.') : tr('O agente quer acompanhar a saída de um comando que já está rodando.'), tr('Risco baixo: não mexe nos seus arquivos.')));
    case 'WebFetch': {
      let host = '';
      try {
        host = new URL(str(input.url)).hostname.replace(/^www\./, '');
      } catch {
        host = '';
      }
      return withCtx(plain('baixo', host ? tr('O agente quer ler uma página do site {0}.', [host]) : tr('O agente quer ler uma página da internet.'), tr('Risco baixo: só leitura; nada seu sai do computador além do endereço da página.')));
    }
    case 'WebSearch':
      return withCtx(plain('baixo', tr('O agente quer pesquisar na internet: “{0}”.', [safe(str(input.query), 60)]), tr('Risco baixo: só uma busca.')));
    case 'TodoWrite':
    case 'TaskCreate':
    case 'TaskUpdate':
    case 'TaskList':
    case 'TaskGet':
    case 'EnterPlanMode':
    case 'ExitPlanMode':
      return withCtx(plain('baixo', tr('O agente quer organizar a própria lista de tarefas.'), tr('Risco baixo: só anotações do agente.')));
    case 'Agent':
    case 'Task': {
      const d = safe(str(input.description), 60);
      return withCtx(plain('baixo', d ? tr('O agente quer chamar um ajudante (subagente) para: {0}.', [d]) : tr('O agente quer chamar um ajudante (subagente).'), tr('Risco baixo: o que o ajudante fizer pede permissão por conta própria.')));
    }
    case 'Workflow':
      return withCtx(plain('medio', tr('O agente quer rodar um fluxo com vários ajudantes ao mesmo tempo.'), tr('Risco médio: vários agentes trabalhando de uma vez gastam mais e pedem mais permissões.')));
    case 'SendMessage':
      return withCtx(plain('medio', tr('O agente quer mandar uma mensagem para outro agente ({0}) neste computador.', [safe(str(input.to), 40) || tr('outro agente')]), tr('Risco médio: nada sai do computador; o outro agente passa a agir com base nela.')));
    case 'ListAgents':
      return withCtx(plain('baixo', tr('O agente quer ver quais outros agentes estão rodando.'), tr('Risco baixo: só consulta.')));
    case 'PushNotification':
    case 'SendUserFile':
      return withCtx(plain('baixo', tr('O agente quer mandar algo para você (um aviso ou um arquivo).'), tr('Risco baixo: vai só para você.')));
    case 'Skill':
    case 'SlashCommand':
      return withCtx(plain('baixo', tr('O agente quer seguir um roteiro pronto (skill {0}).', [safe(str(input.skill) || str(input.command), 40)]), tr('Risco baixo: o roteiro só dá instruções; o que ele fizer depois pede permissão.')));
    case 'ToolSearch':
    case 'ListMcpResourcesTool':
    case 'ReadMcpResourceTool':
      return withCtx(plain('baixo', tr('O agente quer consultar as ferramentas que tem disponíveis.'), tr('Risco baixo: só consulta.')));
    case 'Artifact':
    case 'ArtifactData':
    case 'ArtifactComments':
      return withCtx(plain('medio', tr('O agente quer publicar ou atualizar uma página na sua conta do claude.ai.'), tr('Risco médio: a página fica fora do computador (privada até você compartilhar).')));
    case 'CronCreate':
    case 'CronDelete':
    case 'CronList':
    case 'ScheduleWakeup':
    case 'RemoteTrigger':
      return withCtx(plain(tool === 'CronList' ? 'baixo' : 'medio', tr('O agente quer agendar (ou mudar) uma tarefa que roda sozinha depois.'), tr('Risco médio: algo passa a rodar sem você pedir na hora.')));
    case 'EnterWorktree':
    case 'ExitWorktree':
      return withCtx(plain('baixo', tr('O agente quer trabalhar numa cópia separada do projeto (worktree do git).'), tr('Risco baixo: não mexe na cópia principal.')));
    case 'StructuredOutput':
      return withCtx(plain('baixo', tr('O agente quer entregar o resultado.'), tr('Risco baixo.')));
    // Codex
    case 'apply_patch': {
      const files = patchFiles(str(input.command) || str(input.patch) || str(input.input));
      if (!files.length) return withCtx(plain('medio', tr('O agente quer aplicar mudanças em arquivos (patch).'), tr('Risco médio: o Habblaud não sabe quais arquivos.')));
      const places = files.map((f) => describePlace(f.path, ctx));
      const risk = worstRisk(...places.map(writeRisk), ...files.map((f) => (f.op === 'Delete' ? 'alto' : 'baixo') as PlainRisk));
      const verb = files.every((f) => f.op === 'Add') ? tr('criar') : files.every((f) => f.op === 'Delete') ? tr('apagar') : tr('alterar');
      return withCtx(plain(risk, tr('O agente quer {0} {1} {2}.', [verb, filesPhrase(files.map((f) => f.path)), places[0].label]), files.some((f) => f.op === 'Delete') ? tr('Risco alto: apaga arquivos.') : writeWhy(places[0], tr('editar'))));
    }
    case 'request_permissions':
      return withCtx(plain('medio', tr('O agente quer mais permissões do que tem agora.'), tr('Risco médio: depois disso ele pede menos vezes.')));
    case 'write_stdin':
      return withCtx(plain('medio', tr('O agente quer digitar numa janela de terminal que já está aberta.'), tr('Risco médio: o que ele digita pode responder a um programa em andamento.')));
    default:
      if (tool.startsWith('mcp__')) return withCtx(explainMcp(tool, input));
      return withCtx(plain('medio', tr('O agente quer usar a ferramenta {0}.', [safe(tool, 40)]), tr('Risco médio: ferramenta que o Habblaud não conhece; veja os detalhes técnicos.')));
  }
}
