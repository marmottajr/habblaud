// Último trabalho de cada agente fixo. Quando a sessão de um agente fixo
// fecha, a linha do tempo dela (as atividades, o título e os números) fica guardada aqui, para a gaveta do agente
// parado continuar mostrando o que ele fez. Persistido em <dataDir>/equipe-ultimos.json.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Activity, AgentStats } from '../../shared/types';
import { errMsg, log } from '../log';

export interface UltimoTrabalho {
  /** Atividades da sessão, da mais antiga para a mais recente. */
  history: Activity[];
  title?: string;
  stats: AgentStats;
  sessionId: string;
  startedAt: number;
  endedAt: number;
}

/** O que uma sessão de agente fixo gastou (guardado quando ela fecha). */
export interface NumerosDaSessao {
  tokensIn: number;
  tokensOut: number;
  costUSD?: number;
  toolCalls: number;
  at: number;
}

interface Arquivo {
  versao: 1;
  ultimos: Record<string, UltimoTrabalho>;
  sessoes?: Record<string, NumerosDaSessao>;
}

const MAX_AGENTES = 200;
const MAX_ATIVIDADES = 200;
const MAX_SESSOES = 3_000;

export class StaffHistory {
  private map = new Map<string, UltimoTrabalho>();
  private sessoes = new Map<string, NumerosDaSessao>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  /** `file` null = só em memória (testes ou diretório de dados indisponível). */
  constructor(private readonly file: string | null) {}

  load(): void {
    if (!this.file) return;
    try {
      const j = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<Arquivo>;
      for (const [key, v] of Object.entries(j.ultimos ?? {})) {
        if (!v || !Array.isArray(v.history) || typeof v.sessionId !== 'string' || typeof v.endedAt !== 'number' || !v.stats) continue;
        this.map.set(key, { ...v, history: v.history.slice(-MAX_ATIVIDADES) });
      }
      for (const [id, n] of Object.entries(j.sessoes ?? {})) {
        if (n && typeof n.tokensIn === 'number' && typeof n.tokensOut === 'number') this.sessoes.set(id, n);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log.warn(`equipe-ultimos.json ilegível (${errMsg(err)}); começando do zero.`);
    }
  }

  get(key: string): UltimoTrabalho | undefined {
    return this.map.get(key);
  }

  /** Quanto gastou a sessão `sessionId` (só as de agente fixo que já fecharam). */
  numeros(sessionId: string): NumerosDaSessao | undefined {
    return this.sessoes.get(sessionId);
  }

  /** Guarda o trabalho que acabou. Sessão sem atividade nenhuma (abriu e fechou) não apaga o que havia. */
  set(key: string, trabalho: UltimoTrabalho): void {
    if (trabalho.stats.tokensIn + trabalho.stats.tokensOut > 0) {
      this.sessoes.set(trabalho.sessionId, { tokensIn: trabalho.stats.tokensIn, tokensOut: trabalho.stats.tokensOut, costUSD: trabalho.stats.costUSD, toolCalls: trabalho.stats.toolCalls, at: trabalho.endedAt });
      while (this.sessoes.size > MAX_SESSOES) this.sessoes.delete(this.sessoes.keys().next().value as string);
      this.scheduleFlush();
    }
    if (!trabalho.history.length && this.map.has(key)) return;
    this.map.delete(key);
    this.map.set(key, { ...trabalho, history: trabalho.history.slice(-MAX_ATIVIDADES) });
    // O mais antigo sai quando passa do teto (o Map guarda na ordem de entrada).
    while (this.map.size > MAX_AGENTES) this.map.delete(this.map.keys().next().value as string);
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (!this.file || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, 2_000);
    this.timer.unref?.();
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const file = this.file;
    if (!file) return;
    try {
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify({ versao: 1, ultimos: Object.fromEntries(this.map), sessoes: Object.fromEntries(this.sessoes) } satisfies Arquivo)}\n`);
      renameSync(tmp, file);
      log.clearOnce('ultimos-write');
    } catch (err) {
      log.warnOnce('ultimos-write', `Não foi possível gravar ${file} (${errMsg(err)}); o último trabalho dos agentes vale só nesta execução.`);
    }
  }
}
