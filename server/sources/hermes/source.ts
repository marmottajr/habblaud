// Fonte local, somente leitura: metadados do SQLite do Hermes; nunca consulta prompts,
// respostas, argumentos de ferramentas, credenciais ou dumps de requisições.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Activity, SourceInfo } from '../../../shared/types';
import { ACCOUNT_COLORS } from '../../accounts/detect';
import type { AccountsService } from '../../accounts/service';
import { errMsg, log } from '../../log';
import type { Office } from '../../model/office';
import type { AgentSource } from '../source';

const PRESENCE_MS = 120_000;
const WORKING_MS = 15_000;
interface SessionRow {
  id: string; started_at: number; last_activity_at: number; cwd: string | null; git_repo_root: string | null;
  title: string | null; model: string | null; git_branch: string | null;
  tool_call_count: number | null; input_tokens: number | null; output_tokens: number | null;
}
interface ToolRow { id: number; session_id: string; tool_name: string; timestamp: number }

export interface HermesSourceOptions {
  accounts: AccountsService;
  office: Office;
  dirs: string[];
  now?: () => number;
  pollMs?: number;
}

function toolActivity(key: string, row: ToolRow): Activity {
  const tool = row.tool_name.slice(0, 80);
  const kind = /terminal|execute_code|process/i.test(tool) ? 'run'
    : /browser/i.test(tool) ? 'browser'
    : /web_search|search_files/i.test(tool) ? 'search'
    : /read_file|web_extract/i.test(tool) ? 'read'
    : /write_file|patch/i.test(tool) ? 'edit'
    : /delegate/i.test(tool) ? 'delegate' : 'other';
  return { id: `${key}#${row.id}`, at: row.timestamp * 1000, kind, icon: '⚙️', text: `Usando ${tool}`, tool };
}

export class HermesSource implements AgentSource {
  readonly provider = 'hermes' as const;
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly entries: { dir: string; id: string; error?: string }[];
  private readonly visible = new Set<string>();
  private readonly lastTool = new Map<string, number>();

  constructor(private readonly opts: HermesSourceOptions) {
    this.now = opts.now ?? Date.now;
    const taken = opts.accounts.allEntries();
    const usedColors = new Set(taken.map((e) => e.detected.color));
    const entries = opts.accounts.setProviderAccounts('hermes', opts.dirs.map((dir, i) => {
      const color = ACCOUNT_COLORS.find((c) => !usedColors.has(c)) ?? ACCOUNT_COLORS[i % ACCOUNT_COLORS.length];
      usedColors.add(color);
      return { dir, detected: { id: i ? `.hermes-${i + 1}` : '.hermes', provider: 'hermes' as const,
        configDir: dir, name: i ? `Hermes ${i + 1}` : 'Hermes', short: 'H', color } };
    }));
    this.entries = entries.map((e) => ({ dir: e.dir, id: e.id }));
  }

  start(): void {
    this.boot();
    this.timer = setInterval(() => this.safePoll(), this.opts.pollMs ?? 1000);
    this.timer.unref?.();
  }

  boot(): void {
    this.opts.office.beginBoot();
    try { this.poll(); } finally { this.opts.office.endBoot(); }
  }

  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
  transcriptPathOf(_agentId: string): undefined { return undefined; }
  sources(): SourceInfo[] {
    return this.entries.map((e) => ({ label: e.id, provider: 'hermes', path: e.dir,
      sessions: [...this.visible].filter((k) => k.startsWith(`${e.id}:`)).length,
      ok: !e.error, ...(e.error ? { error: e.error } : {}) }));
  }

  private safePoll(): void {
    try { this.poll(); } catch (err) { log.warnOnce(`hermes-poll:${errMsg(err)}`, `Hermes: falha na leitura (${errMsg(err)}).`); }
  }

  poll(): void {
    const now = this.now();
    const seen = new Set<string>();
    for (const entry of this.entries) {
      if (!existsSync(join(entry.dir, 'state.db'))) continue;
      let db: DatabaseSync | undefined;
      try {
        db = new DatabaseSync(join(entry.dir, 'state.db'), { readOnly: true });
        const sessions = db.prepare(`SELECT id, started_at, last_activity_at, cwd, git_repo_root, title, model, git_branch,
          tool_call_count, input_tokens, output_tokens FROM sessions
          WHERE source = 'cli' AND parent_session_id IS NULL AND ended_at IS NULL
            AND last_activity_at >= ? ORDER BY last_activity_at DESC LIMIT 100`).all((now - PRESENCE_MS) / 1000) as unknown as SessionRow[];
        for (const s of sessions) {
          const cwd = s.git_repo_root || s.cwd;
          if (!cwd || !cwd.startsWith('/')) continue;
          const key = `${entry.id}:${s.id}`;
          seen.add(key);
          const tool = db.prepare(`SELECT id, session_id, tool_name, timestamp FROM messages
            WHERE session_id = ? AND role = 'tool' AND tool_name IS NOT NULL ORDER BY id DESC LIMIT 1`).get(s.id) as ToolRow | undefined;
          const status = tool && now - tool.timestamp * 1000 < WORKING_MS ? 'working' : 'idle';
          if (!this.visible.has(key)) {
            this.opts.office.addMain({ id: key, provider: 'hermes', account: entry.id, sessionId: s.id,
              cwd, role: 'Agente principal (Hermes)', startedAt: s.started_at * 1000, status });
            if (this.opts.office.has(key)) this.visible.add(key);
          } else this.opts.office.setStatus(key, status);
          if (!this.visible.has(key)) continue;
          this.opts.office.applyTranscript(key, {
            tasks: [],
            ...(s.title ? { title: s.title } : {}), ...(s.model ? { model: s.model } : {}),
            ...(s.git_branch ? { gitBranch: s.git_branch } : {}),
            stats: { toolCalls: s.tool_call_count ?? 0, tokensIn: s.input_tokens ?? 0,
              tokensOut: s.output_tokens ?? 0, subagents: 0 },
          });
          if (tool && this.lastTool.get(key) !== tool.id) {
            this.lastTool.set(key, tool.id);
            this.opts.office.addActivity(key, toolActivity(key, tool), status === 'working', { feed: false });
          }
        }
        delete entry.error;
      } catch (err) {
        entry.error = errMsg(err);
        log.warnOnce(`hermes-db:${entry.dir}:${entry.error}`, `Hermes: não foi possível ler os metadados (${entry.error}).`);
        // Não fecha sessões por uma falha transitória na leitura do banco.
        for (const key of this.visible) if (key.startsWith(`${entry.id}:`)) seen.add(key);
      } finally { db?.close(); }
    }
    for (const key of this.visible) if (!seen.has(key)) {
      this.opts.office.closeMain(key);
      this.visible.delete(key);
      this.lastTool.delete(key);
    }
  }
}
