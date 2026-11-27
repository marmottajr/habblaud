// Opções do omp escolhidas em Configurações, persistidas em <dataDir>/omp.json. Hoje só `roomByProject`: com o cwd fora
// de um repositório git, a sala do agente segue o projeto que as ferramentas tocam (sources/omp/parser.ts projectDir).
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { errMsg, log } from '../../log';
import { tr } from '../../../shared/i18n';

export class OmpSettings {
  roomByProject = false;

  /** `file` null = só em memória (testes). */
  constructor(private readonly file: string | null) {}

  load(): void {
    if (!this.file) return;
    try {
      const j = JSON.parse(readFileSync(this.file, 'utf8')) as { roomByProject?: unknown };
      this.roomByProject = j.roomByProject === true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log.warn(tr('omp.json ilegível ({0}); sala por projeto desligada.', [errMsg(err)]));
    }
  }

  setRoomByProject(on: boolean): void {
    this.roomByProject = on;
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(`${this.file}.tmp`, JSON.stringify({ version: 1, roomByProject: on }, null, 2));
      renameSync(`${this.file}.tmp`, this.file);
    } catch (err) {
      log.warn(tr('Não consegui gravar {0}: {1}', [this.file, errMsg(err)]));
    }
  }
}
