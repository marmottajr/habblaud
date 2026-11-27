// Fonte de agentes do omp (AgentSource 'omp', ver sources/source.ts): CLI `omp` (oh-my-pi). Observa as sessões ABERTAS de
// cada agent dir e alimenta o Office; os eventos da extensão do Habblaud (OmpLive, via POST /api/omp/events) chegam por
// applyEvent e adiantam o que o arquivo ainda não conta.
//
// Presença (o omp não grava registro de sessões abertas):
// - sem a extensão: o arquivo `sessions/<pasta>/<início>_<id>.jsonl` mudou nos últimos 10 min e não termina com
//   `session_exit` (files.ts). Saída limpa = `session_exit`: o agente sai em até ~2 s. Processo morto (crash, kill) =
//   10 min até sumir: o arquivo para de crescer e o lock do omp não é visível de fora;
// - com a extensão (session_start, heartbeat...): o batimento (10 s) vale mais que o arquivo. Sem batimento por
//   OMP_HEARTBEAT_LOST_MS o agente sai (crash em até ~35 s) e só volta com um batimento/evento novo ou com escrita nova
//   no arquivo; session_shutdown fecha na hora. Uma sessão sem arquivo (`omp --no-session`) existe só pelos eventos.
// Subagentes (`task`): cada `<arquivo sem .jsonl>/<Nome>.jsonl` é um subagente do principal; entra trabalhando e entrega
// ao concluir o turno ou ao gravar `session_exit`.
//
// Leitura: o cabeçalho (linhas 1-2: título do slot e `session`) é lido uma vez; o resto, por FileTail a partir da
// linha 3. A linha 1 é reescrita no lugar quando o título muda, e o FileTail interpreta isso como arquivo trocado e
// relê tudo (reset): a fonte recarrega, o Office não duplica as atividades (ids estáveis).
//
// Status: aplicado por bordas (início/fim de turno no arquivo, eventos), a informação mais nova vence; o 'waiting' de
// uma aprovação no terminal (approval_requested) só sai com approval_resolved, fim de turno ou fechamento. Boot curto e
// síncrono, com endBoot num `finally`.
//
// Uso do plano (opts.usage, config.ompUsage): com uma sessão principal aberta, roda `omp usage --json` (bin.ts) na
// agent dir da conta a cada USAGE_EVERY_MS e empurra ao AccountsService as janelas do provedor do modelo em uso
// (usage.ts). Uma consulta em voo por vez; troca de provedor lê na hora; falha tenta de novo em USAGE_RETRY_MS.
import { existsSync, watch, type FSWatcher } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Activity, AgentStatus, SourceInfo } from '../../../shared/types';
import { tr } from '../../../shared/i18n';
import { OMP_HEARTBEAT_LOST_MS, type OmpEvent } from '../../../shared/omp-events';
import type { ActivityDescription } from '../../../shared/activity';
import type { DetectedAccount } from '../../accounts/detect';
import type { AccountEntry, AccountsService } from '../../accounts/service';
import { errMsg, log } from '../../log';
import type { Office, TranscriptSummary } from '../../model/office';
import type { AgentSource } from '../source';
import { FileTail } from '../tail';
import type { TerminalParser } from '../terminal';
import { detectOmpAccounts, OMP_SESSIONS_DIR } from './accounts';
import { LivenessCache, OmpIndex, readOmpHead, statFile, subagentsOf, type OmpFile } from './files';
import type { OmpLive } from './live';
import { createOmpTerminalParser } from './terminal';
import { createOmpState, describeOmpTool, parseOmpLine, projectDir, type OmpLineResult, type OmpState } from './parser';
import { ompBinFrom, runOmpUsage, type RunOmpUsage } from './bin';
import { ompProviderOf, parseOmpProviders, parseOmpUsage } from './usage';
import type { OmpHead } from './parser';

/** Varredura completa das pastas de sessões (o resto do polling só re-confere os arquivos conhecidos). */
export const SCAN_MS = 3_000;
/** Depois de fechado (shutdown, batimento perdido), só escrita nova no arquivo depois disto reabre a sessão. */
const REOPEN_GAP_MS = 1_000;
/** Tracker fechado e fora do escritório é esquecido depois disto (a memória do fechamento evita voltar sozinho). */
const TOMBSTONE_MS = 15 * 60_000;
/** Resultados guardados ao ler um arquivo antes de o agente entrar no escritório. */
const BACKLOG_MAX = 400;
/** Cada leitura do FileTail traz até 8 MiB; este teto protege o boot de um arquivo gigante. */
const READ_ROUNDS = 64;
const MAIN_ROLE = tr('Agente principal (omp)');
const SUB_ROLE = tr('Subagente (omp)');
/** Intervalo entre leituras do `omp usage` de uma conta com sessão aberta (o omp tem cache próprio). */
export const USAGE_EVERY_MS = 5 * 60_000;
/** Depois de uma leitura que falhou. */
const USAGE_RETRY_MS = 60_000;

export interface OmpSourceOptions {
  accounts: AccountsService;
  office: Office;
  /** Agent dirs do omp lidas por este processo (no Docker, as montadas), uma por conta. */
  dirs: string[];
  env?: NodeJS.ProcessEnv;
  home?: string;
  now?: () => number;
  pollMs?: number;
  /** Desliga o fs.watch (testes). */
  watch?: boolean;
  /** Uso do plano por `omp usage --json` (config.ompUsage): desligado = nunca roda o omp. */
  usage?: boolean;
  /** Sala segue o projeto quando o cwd não é repositório git (OmpSettings, Configurações); lida a cada ciclo. Ausente = sala do cwd. */
  roomByProject?: () => boolean;
  /** Injeção para testes: substitui runOmpUsage. */
  runUsage?: RunOmpUsage;
  /** Injeção para testes: caminho do omp (padrão ompBinFrom). */
  ompBin?: string;
}

interface OmpAccount {
  id: string;
  /** Agent dir lida por este processo. */
  dir: string;
  /** Pasta para exibir (no Docker, a do host). */
  configDir: string;
  index: OmpIndex;
  liveness: LivenessCache;
  scanAt: number;
  error?: string;
  /** Última leitura do `omp usage` iniciada (0 = nunca) e o provedor lido nela. */
  usageAt: number;
  usageProvider?: string;
  usageBusy: boolean;
  usageFailed: boolean;
}

interface Tracker {
  /** Id do agente no escritório: `omp:<sessão>` ou, no subagente, `omp:<sessão>:<Nome>`. */
  key: string;
  acc: OmpAccount;
  kind: 'main' | 'sub';
  /** Id da sessão principal (no subagente, a do pai). */
  sessionId: string;
  /** Subagente: o Nome do arquivo e a chave do pai. */
  name?: string;
  parentKey?: string;
  path?: string;
  head?: OmpHead;
  tail?: FileTail;
  state: OmpState;
  /** Resultados lidos antes de o agente entrar no escritório (vão como histórico, sem feed). */
  backlog: OmpLineResult[];
  inOffice: boolean;
  /** Projeto dado por um evento (sessões sem arquivo ou ainda sem cabeçalho). */
  eventCwd?: string;
  status: AgentStatus;
  /** Quando o status foi decidido (linha do arquivo ou evento): informação mais velha não o muda. */
  statusAt: number;
  waitingFor?: string;
  /** Visto por um evento da extensão (a presença passa a depender do batimento). */
  extSeen: boolean;
  lastBeatAt?: number;
  closedAt?: number;
  closeReason?: 'shutdown' | 'lost';
  /** mtime do arquivo na última leitura. */
  lastWriteAt?: number;
  /** O arquivo é uma sessão viva (mtime recente e sem session_exit). */
  fileLive: boolean;
  nextResolveAt: number;
  /** Subagente que já entregou. */
  subDone: boolean;
  watcher?: FSWatcher;
  /** Modelos informados pela extensão no session_start. */
  models?: string[];
}

/** `anthropic/claude-sonnet-5-5` → `claude-sonnet-5-5`. */
function shortModel(model: string | undefined): string | undefined {
  return model?.replace(/^[^/]+\//, '').replace(/:[A-Za-z]+$/, '');
}

export class OmpSource implements AgentSource, OmpLive {
  readonly provider = 'omp' as const;
  private accs: OmpAccount[] = [];
  private entries: readonly AccountEntry[] = [];
  private detected: DetectedAccount[] = [];
  private trackers = new Map<string, Tracker>();
  private dirWatchers = new Map<string, FSWatcher>();
  private timer: NodeJS.Timeout | null = null;
  private kick: NodeJS.Timeout | null = null;
  private lastPollAt = 0;
  private forceScan = true;
  private readonly now: () => number;
  private readonly useWatch: boolean;
  private stopped = false;
  /** Executável do omp para o uso do plano (null = não encontrado; undefined = ainda não procurado). */
  private ompBin: string | null | undefined;

  constructor(private readonly opts: OmpSourceOptions) {
    this.now = opts.now ?? Date.now;
    this.useWatch = opts.watch ?? true;
    const other = opts.accounts.entries();
    this.detected = detectOmpAccounts(opts.dirs, {
      env: opts.env ?? process.env,
      home: opts.home,
      taken: { shorts: other.map((e) => e.detected.short), colors: other.map((e) => e.detected.color) },
    });
    this.entries = opts.accounts.setProviderAccounts(
      'omp',
      opts.dirs.map((dir, i) => ({ dir, detected: this.detected[i] })),
    );
    this.accs = this.entries.map((e) => ({
      id: e.id,
      dir: e.dir,
      configDir: e.detected.configDir,
      index: new OmpIndex(e.dir),
      liveness: new LivenessCache(),
      scanAt: -Infinity,
      usageAt: 0,
      usageBusy: false,
      usageFailed: false,
    }));
  }

  /** Contas do omp (ids finais, no AccountsService). */
  accountEntries(): readonly AccountEntry[] {
    return this.entries;
  }

  start(): void {
    this.boot();
    this.timer = setInterval(() => this.safePoll(), this.opts.pollMs ?? 1_000);
    this.timer.unref?.();
  }

  /** Reconstrói as sessões abertas sem gerar avisos. Síncrono. */
  boot(): void {
    this.opts.office.beginBoot();
    try {
      this.poll(true);
    } finally {
      this.opts.office.endBoot();
    }
  }

  stop(): void {
    this.stopped = true;
    clearInterval(this.timer ?? undefined);
    clearTimeout(this.kick ?? undefined);
    this.timer = null;
    this.kick = null;
    for (const w of this.dirWatchers.values()) w.close();
    this.dirWatchers.clear();
  }

  sources(): SourceInfo[] {
    return this.accs.map((acc) => {
      let sessions = 0;
      for (const t of this.trackers.values()) if (t.acc === acc && t.kind === 'main' && t.inOffice) sessions++;
      const info: SourceInfo = { label: acc.id, provider: 'omp', path: acc.configDir, sessions, ok: !acc.error };
      if (acc.error) info.error = acc.error;
      return info;
    });
  }

  transcriptPathOf(agentId: string): string | undefined {
    const t = this.trackers.get(agentId);
    return t?.inOffice ? t.path : undefined;
  }

  terminalParser(agentId: string): TerminalParser | undefined {
    return this.trackers.has(agentId) ? createOmpTerminalParser() : undefined;
  }

  // ---------------------------------------------------------------- polling

  private safePoll(): void {
    try {
      this.poll(false);
    } catch (err) {
      log.warnOnce(`omp-poll:${errMsg(err)}`, tr('omp: falha no ciclo de leitura: {0}', [errMsg(err)]));
    }
  }

  /** Um evento do fs.watch antecipa o próximo ciclo (a varredura completa também). */
  private schedule(): void {
    this.forceScan = true;
    if (this.kick || this.stopped) return;
    const wait = Math.max(60, 150 - (this.now() - this.lastPollAt));
    this.kick = setTimeout(() => {
      this.kick = null;
      this.safePoll();
    }, wait);
    this.kick.unref?.();
  }

  private watchDir(dir: string): void {
    if (!this.useWatch || this.dirWatchers.has(dir) || this.stopped) return;
    try {
      const w = watch(dir, () => this.schedule());
      w.on('error', () => {
        w.close();
        this.dirWatchers.delete(dir);
      });
      this.dirWatchers.set(dir, w);
    } catch {
      // sem fs.watch (pasta de rede, limite de inotify): fica só o polling
    }
  }

  poll(boot = false): void {
    const now = (this.lastPollAt = this.now());
    const scan = this.forceScan || boot;
    this.forceScan = false;
    for (const acc of this.accs) {
      if (scan || now - acc.scanAt >= SCAN_MS) this.scanAccount(acc, now);
    }
    for (const t of [...this.trackers.values()]) {
      if (t.kind !== 'main') continue;
      try {
        this.syncMain(t, now, boot);
      } catch (err) {
        log.warnOnce(`omp-session:${t.key}:${errMsg(err)}`, tr('omp: sessão {0}: {1}', [t.key, errMsg(err)]));
      }
    }
    for (const t of [...this.trackers.values()]) if (t.kind === 'main') this.syncSubs(t, now, boot);
    this.cleanup(now);
    if (this.opts.usage) this.pollUsage(now);
  }

  /** Lê o uso do plano das contas com sessão aberta, no máximo uma consulta em voo (ver cabeçalho). */
  private pollUsage(now: number): void {
    if (this.accs.some((a) => a.usageBusy)) return;
    const env = this.opts.env ?? process.env;
    if (this.ompBin === undefined) this.ompBin = this.opts.ompBin ?? ompBinFrom(env, this.opts.home ?? homedir()) ?? null;
    const bin = this.ompBin;
    if (!bin) {
      log.warnOnce('omp-usage-bin', tr('omp: executável não encontrado; o uso do plano das contas do omp fica de fora (HABBLAUD_OMP_BIN).'));
      return;
    }
    for (const acc of this.accs) {
      let main: Tracker | undefined;
      for (const t of this.trackers.values()) {
        if (t.acc === acc && t.kind === 'main' && t.inOffice && (t.state.lastAt ?? 0) >= (main?.state.lastAt ?? -1)) main = t;
      }
      const provider = ompProviderOf(main?.state.model);
      if (!provider) continue;
      const due =
        acc.usageAt === 0 || provider !== acc.usageProvider || now - acc.usageAt >= (acc.usageFailed ? USAGE_RETRY_MS : USAGE_EVERY_MS);
      if (!due) continue;
      acc.usageBusy = true;
      acc.usageAt = now;
      acc.usageProvider = provider;
      (this.opts.runUsage ?? runOmpUsage)(bin, acc.dir, env)
        .then((raw) => {
          if (this.stopped) return;
          const u = parseOmpUsage(raw, provider, this.now());
          if (!u) {
            acc.usageFailed = true;
            log.warnOnce(`omp-usage-parse:${acc.id}:${provider}`, tr('omp: a saída de "omp usage --json" não trouxe o provedor {0} da conta {1}.', [provider, acc.id]));
            return;
          }
          acc.usageFailed = false;
          const all = parseOmpProviders(raw, this.now());
          if (all?.length) u.ompProviders = all;
          this.opts.accounts.setUsage(acc.id, u);
        })
        .catch((err) => {
          acc.usageFailed = true;
          log.warnOnce(`omp-usage:${acc.id}:${errMsg(err)}`, tr('omp: "omp usage" falhou na conta {0}: {1}', [acc.id, errMsg(err)]));
        })
        .finally(() => {
          acc.usageBusy = false;
        });
      return;
    }
  }

  /** Varre uma agent dir: sessões vivas ganham tracker (as outras só entram se já houver um). */
  private scanAccount(acc: OmpAccount, now: number): void {
    acc.scanAt = now;
    const files = acc.index.scan();
    acc.liveness.retain(new Set(files.map((f) => f.path)));
    this.watchDir(join(acc.dir, OMP_SESSIONS_DIR));
    for (const dir of acc.index.dirs()) this.watchDir(dir);
    for (const f of files) {
      const key = mainKey(f.sessionId);
      if (this.trackers.has(key) || !acc.liveness.isLive(f, now)) continue;
      this.trackers.set(key, this.newTracker(acc, 'main', f.sessionId));
    }
  }

  private newTracker(acc: OmpAccount, kind: 'main' | 'sub', sessionId: string, name?: string, parentKey?: string): Tracker {
    const key = name ? `${mainKey(sessionId)}:${name}` : mainKey(sessionId);
    const t: Tracker = {
      key,
      acc,
      kind,
      sessionId,
      state: createOmpState(),
      backlog: [],
      inOffice: false,
      status: 'idle',
      statusAt: 0,
      extSeen: false,
      fileLive: false,
      nextResolveAt: 0,
      subDone: false,
    };
    if (name) t.name = name;
    if (parentKey) t.parentKey = parentKey;
    return t;
  }

  private cleanup(now: number): void {
    for (const [key, t] of [...this.trackers]) {
      if (t.inOffice || t.fileLive) continue;
      if (t.kind === 'sub') {
        // Subagente que saiu e cujo arquivo não está mais vivo: esquecido (volta com escrita nova, num tracker novo).
        this.drop(key, t);
        continue;
      }
      if (!t.extSeen || (t.closedAt !== undefined && now - t.closedAt > TOMBSTONE_MS)) this.drop(key, t);
    }
  }

  private drop(key: string, t: Tracker): void {
    t.watcher?.close();
    this.trackers.delete(key);
  }

  /** O arquivo do tracker: o caminho conhecido ou o do índice (varredura). */
  private fileOf(t: Tracker): OmpFile | undefined {
    if (t.path) {
      const st = statFile(t.path);
      if (st) return { sessionId: t.sessionId, path: t.path, ...st };
    }
    const f = t.acc.index.find(t.sessionId);
    if (f && !t.path) t.path = f.path;
    return f;
  }

  private syncMain(t: Tracker, now: number, boot: boolean): void {
    if (t.inOffice && !this.opts.office.has(t.key)) t.inOffice = false; // saiu do escritório (graça encerrada)
    const file = this.fileOf(t);
    t.fileLive = !!file && t.acc.liveness.isLive(file, now);
    if (file && t.path !== file.path) t.path = file.path;
    this.pump(t, now, boot);
    this.reconcile(t, now);
  }

  /** Subagentes de uma sessão principal presente: um tracker por `<Nome>.jsonl` vivo da pasta irmã. */
  private syncSubs(parent: Tracker, now: number, boot: boolean): void {
    if (!parent.inOffice || !parent.path) {
      for (const t of this.trackers.values()) if (t.kind === 'sub' && t.parentKey === parent.key && t.inOffice) this.reconcile(t, now);
      return;
    }
    const seen = new Set<string>();
    for (const f of subagentsOf(parent.path)) {
      const key = `${parent.key}:${f.name}`;
      seen.add(key);
      let t = this.trackers.get(key);
      const live = parent.acc.liveness.isLive(f, now);
      if (!t) {
        if (!live) continue;
        t = this.newTracker(parent.acc, 'sub', parent.sessionId, f.name, parent.key);
        t.path = f.path;
        this.trackers.set(key, t);
      }
      t.fileLive = live;
      try {
        this.pump(t, now, boot);
        this.reconcile(t, now);
      } catch (err) {
        log.warnOnce(`omp-sub:${key}:${errMsg(err)}`, tr('omp: subagente {0}: {1}', [key, errMsg(err)]));
      }
    }
    for (const t of this.trackers.values()) {
      if (t.kind === 'sub' && t.parentKey === parent.key && !seen.has(t.key)) {
        t.fileLive = false;
        this.reconcile(t, now);
      }
    }
  }

  // ---------------------------------------------------------------- presença

  /**
   * Sala do agente: o cwd da sessão; com `roomByProject` ligado e o cwd fora de um repositório git (pasta que junta
   * vários projetos), a pasta do projeto em que as últimas ferramentas trabalharam (projectDir).
   */
  private cwdOf(t: Tracker): string | undefined {
    const cwd = t.head?.header?.cwd ?? t.eventCwd;
    if (!cwd || t.kind !== 'main' || !this.opts.roomByProject?.() || existsSync(join(cwd, '.git'))) return cwd;
    return projectDir(cwd, t.state.paths);
  }

  private beatRecent(t: Tracker, now: number): boolean {
    return t.lastBeatAt !== undefined && now - t.lastBeatAt <= OMP_HEARTBEAT_LOST_MS;
  }

  /** O tracker deve estar no escritório agora? */
  private wanted(t: Tracker, now: number): boolean {
    if (t.kind === 'sub') {
      const parent = t.parentKey ? this.trackers.get(t.parentKey) : undefined;
      if (!parent?.inOffice || !this.opts.office.has(parent.key) || this.opts.office.get(parent.key)?.status === 'offline') return false;
      if (t.state.exited || !t.fileLive) return false;
      // Subagente só aparece trabalhando (ou já presente); depois de entregar, sai.
      return t.inOffice || t.status === 'working' || t.status === 'waiting';
    }
    if (!this.cwdOf(t)) return false;
    // Batimento recente vence o session_exit do fim do arquivo: `omp --resume/--restore` reabre a sessão sem escrever
    // nada até a próxima mensagem, e o último registro ainda é o session_exit do processo anterior.
    if (t.state.exited && !(t.extSeen && this.beatRecent(t, now))) return false;
    if (t.closedAt !== undefined) {
      // Fechada por shutdown/batimento perdido: só uma escrita nova (e viva) no arquivo a reabre; eventos reabrem em applyEvent.
      if (t.fileLive && (t.lastWriteAt ?? 0) > t.closedAt + REOPEN_GAP_MS) delete t.closedAt;
      else return false;
    }
    if (t.extSeen) {
      if (this.beatRecent(t, now)) return true;
      t.closedAt = now;
      t.closeReason = 'lost';
      return false;
    }
    return t.fileLive;
  }

  private reconcile(t: Tracker, now: number): void {
    if (!this.wanted(t, now)) {
      if (t.inOffice) this.leave(t);
      return;
    }
    if (!t.inOffice) this.enter(t, now);
    else if (t.kind === 'main') this.opts.office.moveMain(t.key, this.cwdOf(t)!);
  }

  private enter(t: Tracker, now: number): void {
    const office = this.opts.office;
    if (t.kind === 'main') {
      office.addMain({
        id: t.key,
        provider: 'omp',
        account: t.acc.id,
        sessionId: t.sessionId,
        cwd: this.cwdOf(t)!,
        role: MAIN_ROLE,
        startedAt: t.head?.header?.startedAt ?? t.state.firstAt ?? now,
        status: t.status,
        waitingFor: t.waitingFor,
      });
      t.inOffice = office.has(t.key);
      if (!t.inOffice) return;
      // Reaberta dentro do período de graça: o status pode ter mudado enquanto esteve fora.
      office.setStatus(t.key, t.status, t.waitingFor);
    } else {
      const added = office.addSub({
        id: t.key,
        parentId: t.parentKey!,
        sessionId: t.head?.header?.id ?? t.name!,
        role: t.name ?? SUB_ROLE,
        background: false,
        startedAt: t.head?.header?.startedAt ?? t.state.firstAt ?? now,
      });
      if (!added) return;
      t.inOffice = true;
      t.subDone = false;
      if (t.status === 'waiting') office.setStatus(t.key, 'waiting', t.waitingFor);
    }
    this.flushBacklog(t);
    this.applySummary(t);
  }

  /** Sai do escritório: o principal encerra; o subagente entrega (se ainda não tinha entregado). */
  private leave(t: Tracker): void {
    if (!t.inOffice) return;
    const office = this.opts.office;
    if (t.kind === 'sub') {
      if (!t.subDone) office.completeSub(t.key);
      t.subDone = true;
    } else office.closeMain(t.key);
    t.inOffice = false;
  }

  /** Leva o status do tracker ao escritório (o subagente entrega ao ficar ocioso e volta ao trabalhar). */
  private statusToOffice(t: Tracker): void {
    if (!t.inOffice) return;
    const office = this.opts.office;
    if (t.kind === 'main') {
      office.setStatus(t.key, t.status, t.waitingFor);
      return;
    }
    if (t.status === 'idle') {
      if (!t.subDone) office.completeSub(t.key);
      t.subDone = true;
      return;
    }
    if (t.subDone) {
      office.reactivateSub(t.key);
      t.subDone = office.isSubDone(t.key);
    }
    if (!t.subDone) office.setStatus(t.key, t.status, t.waitingFor);
  }

  // ---------------------------------------------------------------- arquivo

  /** Acha o arquivo (sem pressa: no máximo a cada 1 s sem cabeçalho) e lê o que for novo. */
  private pump(t: Tracker, now: number, boot: boolean): void {
    if (!t.tail) {
      if (!t.path || (now < t.nextResolveAt && !boot)) return;
      t.nextResolveAt = now + 1_000;
      this.load(t, t.path);
      if (!t.tail) return;
    }
    this.readNew(t);
  }

  /** Lê o cabeçalho e o arquivo inteiro (da linha 3) como histórico. Sem as duas primeiras linhas ainda: tenta depois. */
  private load(t: Tracker, path: string): void {
    const head = readOmpHead(path);
    if (!head.header) return;
    t.head = head;
    t.path = path;
    t.state = createOmpState(head);
    t.backlog = [];
    const tail = new FileTail(path);
    tail.offset = head.bytes;
    t.tail = tail;
    for (let i = 0; i < READ_ROUNDS; i++) {
      const r = tail.read();
      if (r.missing) break;
      for (const line of r.lines) this.apply(t, parseOmpLine(t.state, line, { idPrefix: t.key, now: this.now() }), false);
      if (!r.more) break;
    }
    t.lastWriteAt = tail.mtimeMs;
    this.settleStatus(t);
    if (t.inOffice) {
      this.flushBacklog(t);
      this.statusToOffice(t);
    }
    this.applySummary(t);
  }

  private readNew(t: Tracker): void {
    const tail = t.tail;
    if (!tail) return;
    for (let i = 0; i < 4; i++) {
      let r;
      try {
        r = tail.read();
      } catch (err) {
        log.warnOnce(`omp-read:${t.key}`, tr('omp: arquivo de {0} ilegível ({1}).', [t.key, errMsg(err)]));
        return;
      }
      if (r.missing) {
        // Apagado ou movido: procura de novo.
        delete t.tail;
        if (t.kind === 'main') delete t.path;
        return;
      }
      t.lastWriteAt = tail.mtimeMs;
      if (r.reset) {
        // O slot do título (linha 1) foi reescrito, ou o arquivo foi trocado: relê como histórico.
        this.load(t, tail.path);
        return;
      }
      for (const line of r.lines) this.apply(t, parseOmpLine(t.state, line, { idPrefix: t.key, now: this.now() }), true);
      if (r.lines.length) this.applySummary(t);
      if (!r.more) break;
    }
  }

  /** Status depois de ler o arquivo todo: o turno aberto é 'working'. Um status mais novo vindo de evento vence. */
  private settleStatus(t: Tracker): void {
    const at = t.state.lastAt ?? 0;
    if (at < t.statusAt) return;
    t.status = t.state.turnOpen ? 'working' : 'idle';
    t.statusAt = at;
    delete t.waitingFor;
  }

  /** Aplica um resultado de linha: ao vivo vai direto ao escritório; na carga inicial, fica no backlog. */
  private apply(t: Tracker, r: OmpLineResult, live: boolean): void {
    for (const sig of r.signals) {
      if (sig.type === 'turnStart') this.decide(t, 'working', r.at, undefined, live);
      else if (sig.type === 'turnEnd') this.decide(t, 'idle', r.at, undefined, live);
    }
    if (!live || !t.inOffice) {
      if (r.activities.length) {
        t.backlog.push(r);
        if (t.backlog.length > BACKLOG_MAX) t.backlog.splice(0, t.backlog.length - BACKLOG_MAX);
      }
      return;
    }
    this.toOffice(t, r, true);
  }

  private toOffice(t: Tracker, r: OmpLineResult, live: boolean): void {
    for (const a of r.activities) this.opts.office.addActivity(t.key, a.activity, a.current, { feed: live });
  }

  private flushBacklog(t: Tracker): void {
    const backlog = t.backlog;
    t.backlog = [];
    for (const r of backlog) this.toOffice(t, r, false);
  }

  /**
   * Muda o status por uma borda (início/fim de turno, evento): informação mais velha que a última decisão não vale.
   * `live` = aplica no escritório agora (a carga inicial só guarda; o status entra junto com o agente).
   */
  private decide(t: Tracker, status: AgentStatus, at: number, waitingFor: string | undefined, live: boolean): void {
    if (at < t.statusAt) return;
    t.statusAt = at;
    t.status = status;
    if (waitingFor) t.waitingFor = waitingFor;
    else delete t.waitingFor;
    if (live) this.statusToOffice(t);
  }

  private applySummary(t: Tracker): void {
    if (!t.inOffice) return;
    const s = t.state;
    const summary: TranscriptSummary = { tasks: s.tasks, stats: { ...s.stats } };
    if (s.title) summary.title = s.title;
    const model = shortModel(s.model);
    if (model) summary.model = model;
    if (s.thinking) summary.thinking = s.thinking;
    if (t.models) summary.models = t.models;
    if (s.firstAt !== undefined) summary.firstAt = s.firstAt;
    if (s.lastAt !== undefined) summary.lastAt = s.lastAt;
    this.opts.office.applyTranscript(t.key, summary);
  }

  // ---------------------------------------------------------------- eventos da extensão (OmpLive)

  applyEvent(ev: OmpEvent): boolean {
    try {
      return this.event(ev);
    } catch (err) {
      log.warnOnce(`omp-event:${errMsg(err)}`, tr('omp: evento da extensão ignorado ({0}).', [errMsg(err)]));
      return false;
    }
  }

  /** Conta de uma sessão nova vinda de evento: a da pasta do arquivo, a do índice; senão a primeira. */
  private accountOf(ev: OmpEvent, sessionId: string): OmpAccount | undefined {
    const file = ev.sessionFile;
    if (file) {
      const norm = (p: string) => p.replaceAll('\\', '/').toLowerCase();
      const f = norm(file);
      const byPath = this.accs.find((a) => f.startsWith(`${norm(join(a.dir, OMP_SESSIONS_DIR))}/`));
      if (byPath) return byPath;
    }
    return this.accs.find((a) => a.index.find(sessionId)) ?? this.accs[0];
  }

  private event(ev: OmpEvent): boolean {
    const now = this.now();
    const sessionId = ev.sessionId.toLowerCase();
    const key = mainKey(sessionId);
    let t = this.trackers.get(key);
    if (ev.event === 'heartbeat' && t?.closeReason === 'shutdown') return true; // batimento atrasado de quem já saiu
    if (!t) {
      const acc = this.accountOf(ev, sessionId);
      if (!acc) return false;
      if (ev.event === 'session_shutdown') return true; // nada a fechar
      t = this.newTracker(acc, 'main', sessionId);
      this.trackers.set(key, t);
    }
    if (ev.cwd) t.eventCwd = ev.cwd;
    if (ev.sessionFile && !t.tail) t.path = ev.sessionFile;
    if (!this.cwdOf(t)) {
      // Sem o projeto no evento: o arquivo da sessão diz (já existindo).
      const f = this.fileOf(t);
      if (f) this.pump(t, now, true);
      if (!this.cwdOf(t)) {
        if (!t.inOffice) this.trackers.delete(key);
        return false;
      }
    }
    t.extSeen = true;
    if (ev.models && JSON.stringify(ev.models) !== JSON.stringify(t.models)) {
      t.models = ev.models;
      this.applySummary(t);
    }
    switch (ev.event) {
      case 'session_start':
        t.lastBeatAt = now;
        delete t.closedAt;
        delete t.closeReason;
        // Sessão nova (ou retomada) nasce ociosa; o turno só começa com agent_start.
        if (!t.inOffice && !t.state.turnOpen) this.decide(t, 'idle', now, undefined, false);
        break;
      case 'heartbeat':
        t.lastBeatAt = now;
        if (t.closeReason === 'lost') {
          delete t.closedAt;
          delete t.closeReason;
        }
        break;
      case 'agent_start':
        this.touch(t, now);
        this.pumpNow(t, now);
        this.decide(t, 'working', now, undefined, true);
        break;
      case 'agent_end':
        this.touch(t, now);
        this.pumpNow(t, now);
        this.decide(t, 'idle', now, undefined, true);
        break;
      case 'tool_start':
        this.touch(t, now);
        this.pumpNow(t, now);
        this.decide(t, 'working', now, undefined, true);
        this.toolEvent(t, ev, now);
        break;
      case 'tool_end':
        this.touch(t, now);
        this.pumpNow(t, now);
        break;
      case 'approval_requested':
        this.touch(t, now);
        this.pumpNow(t, now);
        this.decide(t, 'waiting', now, tr('aprovar no terminal: {0}', [ev.toolName ?? 'omp']), true);
        break;
      case 'approval_resolved':
        this.touch(t, now);
        if (t.status === 'waiting') this.decide(t, 'working', now, undefined, true);
        break;
      case 'session_shutdown':
        t.closedAt = now;
        t.closeReason = 'shutdown';
        this.leave(t);
        return true;
    }
    this.reconcile(t, now);
    return true;
  }

  /** Qualquer evento (menos session_shutdown) vale como sinal de vida: o batimento não precisa vir separado. */
  private touch(t: Tracker, now: number): void {
    t.lastBeatAt = now;
    if (t.closeReason === 'lost') {
      delete t.closedAt;
      delete t.closeReason;
    }
  }

  /** Lê o arquivo agora (o evento chegou antes do próximo ciclo de 1 s). */
  private pumpNow(t: Tracker, now: number): void {
    const file = this.fileOf(t);
    t.fileLive = !!file && t.acc.liveness.isLive(file, now);
    this.pump(t, now, true);
  }

  /** Atividade imediata de uma ferramenta que começou (a linha do arquivo, com os argumentos, vale mais se já estiver lá). */
  private toolEvent(t: Tracker, ev: OmpEvent, now: number): void {
    if (!t.inOffice) return;
    const id = `${t.key}#${ev.toolCallId ?? `ev${now}`}`;
    if (ev.toolCallId && t.state.pending.has(ev.toolCallId)) return; // o arquivo já trouxe a chamada
    const { desc, tool } = describeOmpTool(ev.toolName ?? 'ferramenta', {});
    this.opts.office.addActivity(t.key, toActivity(id, now, desc, tool), true, { feed: true });
  }
}

function mainKey(sessionId: string): string {
  return `omp:${sessionId}`;
}

function toActivity(id: string, at: number, desc: ActivityDescription, tool: string): Activity {
  return { id, at, ...desc, tool };
}
