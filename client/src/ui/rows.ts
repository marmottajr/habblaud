// Linha de agente (avatar, nome, conta, papel, status e atividade), usada na barra lateral e na gaveta.
import type { AccountInfo, AgentInfo } from '../../../shared/types';
import { createAvatar, updateAvatar, type AvatarSize } from './avatar';
import { h, setAttr, setHidden, setStyleVar, setText, setTitle, setVariant } from './dom';
import { formatDuration } from './format';
import { activityFallback, shellLine, shellWaitIn, statusLabel } from './model';
import {
  createAccountChip,
  createActivityLine,
  createRoleBadge,
  createStatusDot,
  updateAccountChip,
  updateActivityLine,
  updateRoleBadge,
  updateShellActivityLine,
  updateStatusDot,
} from './widgets';

interface RowRefs {
  avatar: HTMLElement;
  name: HTMLElement;
  /** A função ao lado do nome. */
  job: HTMLElement;
  chip: HTMLElement;
  role: HTMLElement;
  dot: HTMLElement;
  activity: HTMLElement;
  /** Título da sessão (do que se trata), como no hover do personagem. */
  task: HTMLElement;
  /** Há quanto tempo está ocioso (no lugar do "Principal"). */
  since: HTMLElement;
  size: AvatarSize;
}

const refs = new WeakMap<HTMLElement, RowRefs>();

export function createAgentRow(agent: AgentInfo, onPick: (id: string) => void, size: AvatarSize = 'md'): HTMLButtonElement {
  const avatar = createAvatar(agent, size);
  const name = h('span', { class: 'ui-agent__name' });
  // A função dada pelo usuário (ou a do agente fixo) fica sempre ao lado do nome, em dourado: "Ana [Vendedora]".
  const job = h('span', { class: 'ui-agent__job', hidden: true });
  const chip = createAccountChip('sm');
  const role = createRoleBadge();
  const dot = createStatusDot();
  const activity = createActivityLine();
  const task = h('span', { class: 'ui-agent__task', hidden: true });
  const since = h('span', { class: 'ui-agent__since', hidden: true });
  const row = h(
    'button',
    { class: 'ui-agent', type: 'button' },
    avatar,
    h('span', { class: 'ui-agent__main' }, h('span', { class: 'ui-agent__top' }, name, job, chip, since, role), task, activity),
    dot,
  );
  row.dataset.id = agent.id;
  row.addEventListener('click', () => onPick(row.dataset.id!));
  refs.set(row, { avatar, name, job, chip, role, dot, activity, task, since, size });
  return row;
}

/**
 * `now` = relógio do servidor (cronômetro do shell e limiar dos comandos longos em primeiro plano);
 * `agents` = agentes do escritório (shells que um subagente deixou rodando contam para o principal).
 */
export function updateAgentRow(
  row: HTMLElement,
  agent: AgentInfo,
  account: AccountInfo | undefined,
  selected: boolean,
  now: number,
  agents: readonly AgentInfo[] = [],
): void {
  const r = refs.get(row);
  if (!r) return;
  row.dataset.id = agent.id;
  updateAvatar(r.avatar, agent, r.size);
  setStyleVar(row, '--acc', account?.color ?? '#8b98b3');
  setText(r.name, agent.name);
  const job = agent.kind === 'main' ? (agent.job?.trim() ?? '') : '';
  setText(r.job, job);
  setTitle(r.job, job ? `Função: ${job}` : '');
  setHidden(r.job, !job);
  updateAccountChip(r.chip, account, agent.account, agent.provider);
  updateRoleBadge(r.role, agent);
  const title = agent.title?.trim() ?? '';
  setText(r.task, title);
  setTitle(r.task, title);
  setHidden(r.task, !title);
  // Aqui aparecia há quanto tempo o agente está ocioso ("ocioso 12 min"), no lugar do "Principal". Saiu: o
  // tempo de quem está trabalhando ou esperando, que é o que importa, continua na linha de atividade.
  const showIdle = false;
  setText(r.since, '');
  setTitle(r.since, '');
  setHidden(r.since, true);
  // Com a função já escrita ao lado do nome, o selo repetiria a mesma palavra.
  setHidden(r.role, showIdle || !!job);
  // Esperando um shell (ou parado num comando longo): ampulheta no ponto e o cronômetro na linha de atividade.
  const wait = shellWaitIn(agent, agents, now);
  const status = wait ? 'shell' : agent.status;
  updateStatusDot(r.dot, status);
  if (wait) updateShellActivityLine(r.activity, wait, now);
  else updateActivityLine(r.activity, agent.activity, activityFallback(agent));
  setVariant(row, 'is-', status);
  row.classList.toggle('is-selected', selected);
  setAttr(row, 'aria-current', selected ? 'true' : null);
  // Para leitores de tela, o tempo em minutos (o cronômetro mudaria o rótulo a cada segundo).
  const doing = wait ? `${shellLine(wait, now).label}, há ${formatDuration(now - wait.since)}` : agent.activity?.text;
  setAttr(
    row,
    'aria-label',
    `${agent.name}, ${agent.kind === 'main' ? (job ? job : 'agente principal') : `subagente ${agent.role}`}, ${account?.name ?? agent.account}${agent.provider === 'codex' ? ' (Codex)' : ''}, ${statusLabel(status)}${doing ? `: ${doing}` : ''}`,
  );
}
