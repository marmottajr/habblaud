// Observador das sessões abertas do Kiro CLI 3.x (uma instância por pasta do Kiro).
// - Aberta = <pasta>/session-leases/<sessionId>.lease aponta para um processo do Kiro vivo (liveness.ts, como no
//   2.x; sem lista de processos, vale o mtime da trava, do session.json e do messages.jsonl).
// - Da trava só saem pid, parentPid e acquiredAt: o token dela nunca é lido para fora daqui nem vai para o log.
// - Ao achar a sessão, relê o fim do messages.jsonl (até REPLAY_MAX_BYTES) só para o histórico (feed: false); depois,
//   cada linha nova vira atividade ao vivo (v3parser.ts), com tarefas (todo_list), números e shells (ShellTracker).
// - Subagentes (sub_agent_start / sub_agent_complete no messages.jsonl): cada um vira personagem próprio
//   ("<sessionId>:<subSessionId>"), com atividades, status, tarefas e shells lidos de
//   sub-executions/<subSessionId>.jsonl (mesmo formato; o arquivo pode aparecer depois do start).
//   Na releitura, subagente que começou e terminou dentro dela não entra (como no Claude Code).
// - Trava sumiu ou processo morreu: os subagentes saem calados e o personagem sai (closeMain).
import { existsSync, readdirSync, readFileSync, statSync, watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import type { Activity, AgentStatus } from '../../../shared/types';
import { SPECIAL, truncate } from '../../../shared/activity';
import { tr } from '../../../shared/i18n';
import { errMsg, log } from '../../log';
import type { Office } from '../../model/office';
import { SHELL_FALLBACK_MAX_AGE_MS, ShellTracker, toShellJob, type ShellFinish } from '../shells';
import { FileTail } from '../tail';
import type { KiroHookPayload } from './live';
import { chooseLivenessMode, createLiveness, type KiroLiveness } from './liveness';
import { cleanKiroTitle } from './parser';
import { applyKiroV3Line, createKiroV3State, type KiroV3LineResult, type KiroV3State, type KiroV3SubComplete, type KiroV3SubStart } from './v3parser';
import { isKiroV3SessionId, kiroV3SessionDir, kiroV3SubAgentId, kiroV3SubTranscriptFile, parseKiroV3SubAgentId } from './v3paths';
import { kiroRole, REPLAY_MAX_BYTES, STALE_LOCK_MS } from './watcher';

/** Atividades da releitura que entram no histórico do agente. */
const REPLAY_MAX_ACTIVITIES = 200;

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const pidOf = (v: unknown): number => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : 0);

export interface KiroV3Lease {
  pid: number;
  parentPid: number;
  acquiredAt?: number;
}

/** Lê só o que serve da trava (pid, parentPid, acquiredAt). undefined = arquivo ilegível (sendo reescrito). */
export function readKiroV3Lease(path: string): KiroV3Lease | undefined {
  let raw: Obj;
  try {
    raw = obj(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return undefined;
  }
  const t = raw.acquiredAt;
  const at = typeof t === 'number' ? (t < 1e12 ? t * 1000 : t) : Date.parse(str(t));
  return { pid: pidOf(raw.pid), parentPid: pidOf(raw.parentPid), ...(Number.isFinite(at) && at > 0 ? { acquiredAt: at } : {}) };
}

export interface KiroV3Meta {
  cwd: string;
  title?: string;
  role?: string;
  model?: string;
  createdAt?: number;
}

export function readKiroV3Meta(path: string): KiroV3Meta | undefined {
  let m: Obj;
  try {
    m = obj(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return undefined;
  }
  const paths = Array.isArray(m.workspacePaths) ? m.workspacePaths.filter((p): p is string => typeof p === 'string' && !!p) : [];
  const role = kiroRole(str(m.agentMode) || undefined);
  const created = Date.parse(str(m.createdAt));
  return {
    cwd: paths[0] ?? '',
    ...(str(m.title) ? { title: str(m.title) } : {}),
    ...(role ? { role } : {}),
    ...(str(m.modelId) ? { model: str(m.modelId) } : {}),
    ...(Number.isFinite(created) ? { createdAt: created } : {}),
  };
}

export interface KiroV3WatcherDeps {
  office: Office;
  /** Pasta do Kiro (~/.kiro): session-leases/ e sessions/<hash>/<id>/ ficam nela. */
  kiroDir: string;
  account?: string;
  pollMs?: number;
  now?: () => number;
  inDocker?: boolean;
  /** Mesma liveness do KiroWatcher da pasta (uma lista de processos só). */
  liveness?: KiroLiveness;
  staleMs?: number;
  env?: NodeJS.ProcessEnv;
  /** Chamado quando a sessão passa a ser deste watcher (a fonte tira o personagem só do hook). */
  onTrack?: (sessionId: string) => void;
}

/** Subagente do 3.x aberto no escritório. */
interface V3Sub {
  /** Id do personagem ("<sessionId>:<subSessionId>"). */
  id: string;
  subSessionId: string;
  /** sub-executions/<subSessionId>.jsonl (pode ainda não existir). */
  path: string;
  tail: FileTail;
  state: KiroV3State;
  shells: ShellTracker;
  base: AgentStatus;
  waitingFor?: string;
  startedAt: number;
  /** Já recebeu o sub_agent_complete (fica só para o terminal achar o arquivo). */
  done: boolean;
}

interface V3Session {
  sessionId: string;
  pid: number;
  parentPid: number;
  startedAt: number;
  dir: string;
  lease: string;
  meta: string;
  transcript: string;
  metaMtime: number;
  tail: FileTail;
  state: KiroV3State;
  shells: ShellTracker;
  /** Status que o transcript dá (sem o 'shell', que sai dos shells em segundo plano). */
  base: AgentStatus;
  waitingFor?: string;
  title?: string;
  model?: string;
  fsWatcher?: FSWatcher;
  /** subSessionId -> subagente (abertos e concluídos desta sessão). */
  subs: Map<string, V3Sub>;
}

export class KiroV3Watcher {
  readonly liveness: KiroLiveness;
  private readonly office: Office;
  private readonly kiroDir: string;
  private readonly leasesDir: string;
  private readonly account: string;
  private readonly pollMs: number;
  private readonly now: () => number;
  private readonly staleMs: number;
  private readonly onTrack?: (id: string) => void;
  private readonly dirCache = new Map<string, string>();
  private active = new Map<string, V3Session>();
  private timer?: NodeJS.Timeout;
  private fsWatcher?: FSWatcher;
  private running = false;

  constructor(deps: KiroV3WatcherDeps) {
    const env = deps.env ?? process.env;
    this.office = deps.office;
    this.kiroDir = deps.kiroDir;
    this.leasesDir = join(deps.kiroDir, 'session-leases');
    this.account = deps.account ?? '.kiro';
    this.pollMs = deps.pollMs ?? 2_000;
    this.now = deps.now ?? Date.now;
    this.staleMs = deps.staleMs ?? STALE_LOCK_MS;
    this.onTrack = deps.onTrack;
    this.liveness = deps.liveness ?? createLiveness(chooseLivenessMode({ env, sessionsDir: deps.kiroDir, inDocker: deps.inDocker }));
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    if (existsSync(this.leasesDir)) {
      this.office.beginBoot();
      try {
        this.scan();
      } finally {
        this.office.endBoot();
      }
      this.watchDir();
    }
    this.timer = setInterval(() => {
      if (!this.fsWatcher && existsSync(this.leasesDir)) this.watchDir();
      this.scan();
    }, this.pollMs);
    this.timer.unref();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.fsWatcher?.close();
    this.fsWatcher = undefined;
    for (const s of this.active.values()) s.fsWatcher?.close();
    this.active.clear();
  }

  private watchDir(): void {
    try {
      this.fsWatcher = watch(this.leasesDir, () => this.scan());
      this.fsWatcher.on('error', () => {
        this.fsWatcher?.close();
        this.fsWatcher = undefined; // segue no polling
      });
    } catch (err) {
      log.warnOnce(`kiro-v3-watch:${this.leasesDir}`, tr('Kiro: falha ao criar watcher fs ({0}), usando polling.', [errMsg(err)]));
    }
  }

  sessionCount(): number {
    return this.active.size;
  }

  has(sessionId: string): boolean {
    return this.active.has(sessionId);
  }

  /** Transcript da sessão ou, para "<sessionId>:<subSessionId>", o sub-executions do subagente. */
  transcriptPathOf(agentId: string): string | undefined {
    const main = this.active.get(agentId);
    if (main) return main.transcript;
    const ref = parseKiroV3SubAgentId(agentId);
    return ref ? this.active.get(ref.sessionId)?.subs.get(ref.subSessionId)?.path : undefined;
  }

  private freshest(paths: string[]): number {
    let best = 0;
    for (const f of paths) {
      try {
        best = Math.max(best, statSync(f).mtimeMs);
      } catch {
        // ainda não existe
      }
    }
    return best;
  }

  private alive(lease: KiroV3Lease, files: string[], now: number): boolean {
    if (this.liveness.mode !== 'mtime') {
      const v = lease.pid ? this.liveness.isKiro(lease.pid) : false;
      if (v === true) return true;
      // O pid da trava pode ser o filho do Kiro; o pai só conta se também for um Kiro.
      if (v === false) return lease.parentPid ? this.liveness.isKiro(lease.parentPid) === true : false;
      if (this.liveness.mode === 'pid') return false;
    }
    return now - this.freshest(files) <= this.staleMs;
  }

  scan(): void {
    let files: string[];
    try {
      files = readdirSync(this.leasesDir).filter((f) => f.endsWith('.lease'));
    } catch {
      files = [];
    }
    const now = this.now();
    if (files.length) this.liveness.refresh?.(now);
    const live = new Set<string>();
    for (const f of files) {
      const id = f.slice(0, -'.lease'.length);
      if (!isKiroV3SessionId(id)) continue;
      const leasePath = join(this.leasesDir, f);
      const lease = readKiroV3Lease(leasePath);
      if (!lease) {
        if (this.active.has(id)) live.add(id); // trava sendo reescrita: fica como está
        continue;
      }
      const cur = this.active.get(id);
      const dir = cur?.dir ?? kiroV3SessionDir(this.kiroDir, id, this.dirCache);
      if (!dir) continue; // sem transcript ainda: o hook segura o personagem
      const meta = join(dir, 'session.json');
      const transcript = join(dir, 'messages.jsonl');
      if (!this.alive(lease, [leasePath, meta, transcript], now)) continue;
      live.add(id);
      if (cur) {
        cur.pid = lease.pid;
        cur.parentPid = lease.parentPid;
      } else this.track(id, lease, dir, leasePath);
    }
    for (const s of this.active.values()) this.pump(s);
    for (const id of [...this.active.keys()]) {
      if (live.has(id)) continue;
      const s = this.active.get(id);
      s?.fsWatcher?.close();
      // Sessão fechou: subagentes ainda trabalhando saem sem aviso de entrega.
      for (const sub of s?.subs.values() ?? []) if (!sub.done) this.office.completeSub(sub.id, { notify: false });
      this.active.delete(id);
      this.office.closeMain(id);
    }
  }

  private track(sessionId: string, lease: KiroV3Lease, dir: string, leasePath: string): void {
    const metaPath = join(dir, 'session.json');
    const meta = readKiroV3Meta(metaPath);
    if (!meta?.cwd) return;
    let metaMtime = 0;
    try {
      metaMtime = statSync(metaPath).mtimeMs;
    } catch {
      // segue sem
    }
    const now = this.now();
    const startedAt = lease.acquiredAt ?? meta.createdAt ?? now;
    const s: V3Session = {
      sessionId,
      pid: lease.pid,
      parentPid: lease.parentPid,
      startedAt,
      dir,
      lease: leasePath,
      meta: metaPath,
      transcript: join(dir, 'messages.jsonl'),
      metaMtime,
      tail: new FileTail(join(dir, 'messages.jsonl')),
      state: createKiroV3State(),
      shells: new ShellTracker(),
      base: 'idle',
      ...(meta.model ? { model: meta.model } : {}),
      subs: new Map(),
    };

    // Releitura: só histórico; o status sai da última linha.
    s.tail.seekTail(REPLAY_MAX_BYTES);
    const acts: Activity[] = [];
    let firstPrompt: string | undefined;
    let lastAt = 0;
    // Subagentes que começaram na releitura e ainda não terminaram (os terminados ficam de fora, como no Claude Code).
    const openSubs = new Map<string, { start: KiroV3SubStart; at: number }>();
    for (let res = s.tail.read(); ; res = s.tail.read()) {
      for (const line of res.lines) {
        const r = applyKiroV3Line(s.state, line, { idPrefix: sessionId, now });
        if (!r) continue;
        if (r.at > lastAt) lastAt = r.at;
        if (r.subStart) openSubs.set(r.subStart.subSessionId, { start: r.subStart, at: r.at });
        if (r.subComplete) openSubs.delete(r.subComplete.subSessionId);
        acts.push(...r.activities);
        this.applyShells(s, sessionId, r); // shell que terminou dentro da releitura já está no passado: sem 'ShellDone'
        if (r.status) {
          s.base = r.status;
          s.waitingFor = r.waitingFor;
          s.shells.holdForeground(r.status === 'waiting', r.at);
        }
        firstPrompt ??= r.promptText;
      }
      if (!res.more) break;
    }
    // A última linha é de antes desta trava (sessão retomada noutro processo): o turno dela não está rodando.
    if (lastAt && lease.acquiredAt && lastAt < lease.acquiredAt && s.base !== 'idle') {
      s.base = 'idle';
      s.waitingFor = undefined;
      s.state.approvals.clear();
      s.shells.endForeground(undefined, lease.acquiredAt);
    }
    // Subagente do processo anterior (sessão retomada) não roda mais.
    if (lastAt && lease.acquiredAt && lastAt < lease.acquiredAt) openSubs.clear();
    // Shells morrem com o processo: o que começou antes da trava não roda mais.
    s.shells.prune(now, lease.acquiredAt);
    s.title = cleanKiroTitle(meta.title) ?? (firstPrompt ? truncate(firstPrompt, 90) : undefined);

    this.active.set(sessionId, s);
    this.onTrack?.(sessionId);
    const status = this.effective(s, now);
    this.office.addMain({
      id: sessionId,
      provider: 'kiro',
      account: this.account,
      sessionId,
      cwd: meta.cwd,
      role: meta.role || tr('Agente do Kiro'),
      startedAt,
      status,
      ...(status === 'waiting' && s.waitingFor ? { waitingFor: s.waitingFor } : {}),
    });
    this.publish(s, lastAt || undefined);
    const keep = acts.slice(-REPLAY_MAX_ACTIVITIES);
    keep.forEach((a, i) => this.office.addActivity(sessionId, a, i === keep.length - 1, { feed: false }));
    this.publishShells(sessionId, s.shells);
    this.office.setStatus(sessionId, status, s.waitingFor);
    this.office.fillShellActivity(sessionId);
    for (const { start, at } of openSubs.values()) this.openSub(s, start, at, true);
    try {
      s.fsWatcher = watch(dir, () => this.pump(s));
      s.fsWatcher.on('error', () => {
        s.fsWatcher?.close();
        s.fsWatcher = undefined; // segue no polling
      });
    } catch {
      // segue no polling
    }
  }

  /** Status mostrado: ocioso com Bash em segundo plano rodando = esperando o shell. */
  private effective(s: Pick<V3Session, 'base' | 'shells'>, now: number): AgentStatus {
    return s.base === 'idle' && s.shells.hasBackgroundShell(now, SHELL_FALLBACK_MAX_AGE_MS) ? 'shell' : s.base;
  }

  /** `owner` = id do personagem dono dos shells (a sessão ou o subagente). */
  private applyShells(s: Pick<V3Session, 'shells'>, owner: string, r: KiroV3LineResult): ShellFinish[] {
    const out: ShellFinish[] = [];
    for (const sig of r.shells) {
      if (sig.type === 'start') s.shells.start(owner, sig.shell);
      else if (sig.type === 'turnEnd') s.shells.endForeground(undefined, r.at);
      else {
        const bg = s.shells.list().find((j) => j.toolUseId === sig.toolUseId)?.background;
        if (bg) {
          const fin = s.shells.notify({ toolUseId: sig.toolUseId, status: sig.error ? 'failed' : 'completed', at: r.at });
          if (fin) out.push(fin);
        } else s.shells.result(sig.toolUseId, { error: sig.error, at: r.at });
      }
    }
    return out;
  }

  private reportShellDone(agentId: string, fin: ShellFinish, live: boolean): void {
    const job = fin.job;
    const input: { id: string; label: string; startedAt: number; command?: string } = { id: job.toolUseId, label: job.label, startedAt: job.startedAt };
    if (job.command) input.command = job.command;
    this.office.shellDone(agentId, input, fin.outcome, fin.at, job.command ? { live, summary: job.command } : { live });
  }

  private publishShells(agentId: string, shells: ShellTracker): void {
    this.office.setShells(agentId, shells.list().map(toShellJob));
  }

  private publish(s: V3Session, lastAt?: number): void {
    this.office.applyTranscript(s.sessionId, {
      ...(s.title ? { title: s.title } : {}),
      tasks: s.state.tasks.map((t) => ({ ...t })),
      stats: { ...s.state.stats },
      ...(s.model ? { model: s.model } : {}),
      ...(lastAt ? { lastAt } : {}),
    });
  }

  private refreshMeta(s: V3Session): boolean {
    let mtime: number;
    try {
      mtime = statSync(s.meta).mtimeMs;
    } catch {
      return false;
    }
    if (mtime === s.metaMtime) return false;
    const meta = readKiroV3Meta(s.meta);
    if (!meta) return false; // escrita pela metade: tenta na próxima
    s.metaMtime = mtime;
    s.title = cleanKiroTitle(meta.title) ?? s.title;
    s.model = meta.model ?? s.model;
    return true;
  }

  private pump(s: V3Session): void {
    if (!this.active.has(s.sessionId)) return;
    let changed = this.refreshMeta(s);
    let shellsChanged = false;
    let lastAt: number | undefined;
    for (let res = s.tail.read(); ; res = s.tail.read()) {
      for (const line of res.lines) {
        const r = applyKiroV3Line(s.state, line, { idPrefix: s.sessionId, now: this.now() });
        if (!r) continue;
        lastAt = Math.max(lastAt ?? 0, r.at);
        if (!s.title && r.promptText) {
          s.title = truncate(r.promptText, 90);
          changed = true;
        }
        if (r.tasksChanged || r.statsChanged) changed = true;
        for (const a of r.activities) this.office.addActivity(s.sessionId, a, true);
        if (r.shells.length) {
          shellsChanged = true;
          for (const fin of this.applyShells(s, s.sessionId, r)) this.reportShellDone(s.sessionId, fin, true);
        }
        if (r.subStart) this.openSub(s, r.subStart, r.at, false);
        if (r.subComplete) this.finishSub(s, r.subComplete, r.at);
        if (r.status) {
          s.base = r.status;
          s.waitingFor = r.waitingFor;
          s.shells.holdForeground(r.status === 'waiting', r.at);
          shellsChanged = true;
          this.office.setStatus(s.sessionId, this.effective(s, this.now()), s.waitingFor);
        }
      }
      if (!res.more) break;
    }
    const now = this.now();
    if (s.shells.prune(now, s.startedAt)) shellsChanged = true;
    if (changed) this.publish(s, lastAt);
    if (shellsChanged) this.publishShells(s.sessionId, s.shells);
    this.office.setStatus(s.sessionId, this.effective(s, now), s.waitingFor);
    this.office.fillWorkingActivity(s.sessionId);
    this.office.fillShellActivity(s.sessionId);
    for (const sub of s.subs.values()) if (!sub.done) this.pumpSub(s, sub, true);
  }

  // ---------------------------------------------------------------- subagentes

  /**
   * Põe o subagente no escritório. `replay` = já rodava quando a sessão foi achada: o que ele já escreveu vai só para o
   * histórico (feed: false), como na sessão principal. Sem replay, o arquivo é novo e tudo entra ao vivo.
   */
  private openSub(s: V3Session, start: KiroV3SubStart, at: number, replay: boolean): void {
    const prev = s.subs.get(start.subSessionId);
    if (prev && !prev.done) return; // o mesmo start de novo
    const path = kiroV3SubTranscriptFile(s.dir, start.subSessionId);
    if (!path) return;
    const id = kiroV3SubAgentId(s.sessionId, start.subSessionId);
    const added = this.office.addSub({
      id,
      parentId: s.sessionId,
      sessionId: s.sessionId,
      role: start.role || tr('Subagente'),
      ...(start.title ? { title: start.title } : {}),
      background: false,
      startedAt: at,
    });
    if (!added) return;
    const state = createKiroV3State();
    state.inTurn = true; // o subagente nasce trabalhando no pedido do agente principal
    const sub: V3Sub = { id, subSessionId: start.subSessionId, path, tail: new FileTail(path), state, shells: new ShellTracker(), base: 'working', startedAt: at, done: false };
    s.subs.set(start.subSessionId, sub);
    if (replay) sub.tail.seekTail(REPLAY_MAX_BYTES);
    this.pumpSub(s, sub, !replay);
  }

  /** Lê o que o subagente escreveu desde a última vez. `live` = false: só histórico (releitura). */
  private pumpSub(s: V3Session, sub: V3Sub, live: boolean): void {
    if (!this.office.has(sub.id)) return; // saiu do escritório (período de graça)
    let changed = false;
    let shellsChanged = false;
    let lastAt: number | undefined;
    const acts: Activity[] = [];
    // shortcut: o fs.watch da sessão não vê sub-executions/; o arquivo do subagente anda no polling (pollMs) e a cada
    // linha nova do messages.jsonl. Trocar por watch da pasta sub-executions/ se a latência incomodar.
    for (let res = sub.tail.read(); ; res = sub.tail.read()) {
      for (const line of res.lines) {
        const r = applyKiroV3Line(sub.state, line, { idPrefix: sub.id, now: this.now() });
        if (!r) continue;
        lastAt = Math.max(lastAt ?? 0, r.at);
        if (r.tasksChanged || r.statsChanged) changed = true;
        if (live) for (const a of r.activities) this.office.addActivity(sub.id, a, true);
        else acts.push(...r.activities);
        if (r.shells.length) {
          shellsChanged = true;
          for (const fin of this.applyShells(sub, sub.id, r)) if (live) this.reportShellDone(sub.id, fin, true);
        }
        if (r.status) {
          sub.base = r.status;
          sub.waitingFor = r.waitingFor;
          sub.shells.holdForeground(r.status === 'waiting', r.at);
          shellsChanged = true;
        }
      }
      if (!res.more) break;
    }
    if (acts.length) {
      const keep = acts.slice(-REPLAY_MAX_ACTIVITIES);
      keep.forEach((a, i) => this.office.addActivity(sub.id, a, i === keep.length - 1, { feed: false }));
    }
    const now = this.now();
    if (sub.shells.prune(now, s.startedAt)) shellsChanged = true;
    if (changed || lastAt) {
      this.office.applyTranscript(sub.id, {
        tasks: sub.state.tasks.map((t) => ({ ...t })),
        stats: { ...sub.state.stats },
        ...(lastAt ? { lastAt } : {}),
      });
    }
    if (shellsChanged) this.publishShells(sub.id, sub.shells);
    if (this.office.isSubDone(sub.id)) return;
    this.office.setStatus(sub.id, this.effective(sub, now), sub.waitingFor);
    this.office.fillWorkingActivity(sub.id);
    this.office.fillShellActivity(sub.id);
  }

  /** sub_agent_complete: lê o resto do arquivo do subagente, mostra a resposta (ou o erro) e o tira do trabalho. */
  private finishSub(s: V3Session, done: KiroV3SubComplete, at: number): void {
    const sub = s.subs.get(done.subSessionId);
    if (!sub || sub.done) return;
    this.pumpSub(s, sub, true);
    const base = `${sub.id}#complete`;
    if (done.error) this.office.addActivity(sub.id, { id: `${base}:err`, at, ...SPECIAL.error(undefined, done.text), error: true }, true);
    else if (done.text) this.office.addActivity(sub.id, { id: `${base}:r`, at, ...SPECIAL.respond(done.text) }, true);
    sub.done = true;
    sub.shells.endForeground(undefined, at);
    this.office.completeSub(sub.id);
  }

  /**
   * Evento do hook (mod/habblaud-kiro) de uma sessão deste watcher. O transcript é a fonte das atividades; o hook só
   * adianta a leitura e o começo do turno (o pedido pode chegar antes da linha "user"). false = sessão desconhecida.
   */
  applyHook(sessionId: string, e: KiroHookPayload): boolean {
    const s = this.active.get(sessionId);
    if (!s) return false;
    this.pump(s);
    if (e.hook_event_name === 'UserPromptSubmit' && s.base === 'idle') {
      s.base = 'working';
      this.office.setStatus(sessionId, 'working');
    }
    return true;
  }
}
