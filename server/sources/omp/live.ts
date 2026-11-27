// Eventos da extensão do Habblaud no omp (a parte "ao vivo" da fonte do omp): a extensão manda cada evento para
// POST /api/omp/events e a rota repassa aqui. A fonte do omp (sources/omp/source.ts) implementa.
import type { OmpEvent } from '../../../shared/omp-events';

export interface OmpLive {
  /**
   * Aplica um evento da extensão ao escritório (sessão nova, início e fim de turno, ferramenta, aprovação no terminal,
   * batimento, encerramento). Devolve false para evento que não casa com nenhuma conta do omp ou sem sessão que o
   * explique (sem o projeto, não há sala).
   */
  applyEvent(ev: OmpEvent): boolean;
}
