// De qual ferramenta é cada coisa (Claude Code, Codex ou omp) e os textos que mudam com ela. Puro (sem DOM): testado em
// ui/provider.test.ts. No protocolo, `provider` ausente quer dizer Claude Code (shared/types.ts); aqui tudo cai nisso.
//
// Identidade visual do Codex e do omp (sem logotipo de ninguém): o chip da conta fica "vazado" (fundo escuro, borda e
// letra na cor da conta, cantos em degrau; o do omp tem o canto cortado só em cima, para os dois não se confundirem) e,
// onde há espaço, um selo de texto ("Codex", "omp") ao lado do nome.
import type { AccountInfo, OfficeSnapshot, Provider } from '../../../shared/types';
import { shortcutHint } from './model';
import { tr } from '../../../shared/i18n';

/** Nome de cada ferramenta como aparece nos textos. */
export const PROVIDER_NAME: Record<Provider, string> = { claude: 'Claude Code', codex: 'Codex', omp: 'omp' };

/** Ferramenta de um agente, conta, sessão ou pedido (ausente = Claude Code). */
export function providerOf(x: { provider?: Provider } | null | undefined): Provider {
  return x?.provider ?? 'claude';
}

export function isCodex(x: { provider?: Provider } | null | undefined): boolean {
  return x?.provider === 'codex';
}

export function isOmp(x: { provider?: Provider } | null | undefined): boolean {
  return x?.provider === 'omp';
}

/**
 * O id de conta tem cara de pasta do Codex (".codex", ".codex-trabalho", ".codex~2", "demo:.codex")? Só para quando a
 * conta já não está no snapshot (ex.: histórico, "Meu dia"): com a conta à mão, vale o `provider` dela.
 */
export function looksLikeCodexId(id: string): boolean {
  return /(?:^|[:/\\])\.?codex(?:[-_.~]|$)/i.test(id);
}

/** O id de conta tem cara de pasta do omp (".omp", ".omp~2", "demo:.omp")? Mesma regra do Codex, só para contas fora do snapshot. */
export function looksLikeOmpId(id: string): boolean {
  return /(?:^|[:/\\])\.?omp(?:[-_.~]|$)/i.test(id);
}

/** Ferramenta da conta: a do snapshot; sem ela, a dica de quem chamou ou o jeito do id. */
export function accountProvider(account: Pick<AccountInfo, 'provider'> | undefined, fallbackId = '', hint?: Provider): Provider {
  if (account) return providerOf(account);
  if (hint) return hint;
  return looksLikeCodexId(fallbackId) ? 'codex' : looksLikeOmpId(fallbackId) ? 'omp' : 'claude';
}

/**
 * Letra do chip de uma conta que não está no snapshot: a primeira letra depois do prefixo da pasta
 * (".claude-conta2" -> "C", ".codex-trabalho" -> "T"). A pasta padrão do Codex (".codex") vira "X", a do omp (".omp"),
 * "O"; a do Claude Code, "?" (como antes). Nunca devolve "." nem vazio.
 */
export function fallbackShort(id: string, provider: Provider = accountProvider(undefined, id)): string {
  const rest = id
    .replace(/^.*:/, '')
    .replace(/~\d+$/, '')
    .replace(/^\.?(?:claude|codex|omp)(?=[-_.]|$)[-_.]?/i, '');
  const letter = /[\p{L}\p{N}]/u.exec(rest)?.[0];
  if (letter) return letter.toUpperCase();
  return provider === 'codex' ? 'X' : provider === 'omp' ? 'O' : '?';
}

/** O selo de texto ao lado do nome da conta ("Codex", "omp"; não repete quando o nome já o diz). */
export function showsProviderTag(provider: Provider, accountName = ''): boolean {
  return provider !== 'claude' && !accountName.toLowerCase().includes(PROVIDER_NAME[provider].toLowerCase());
}

/** Rótulo do chip da conta (dica e leitores de tela): "Conta C (dev@x.com)", "Codex · plano Team", "omp". */
export function accountChipLabel(account: Pick<AccountInfo, 'name' | 'email' | 'plan' | 'provider'> | undefined, fallbackId: string, provider: Provider): string {
  if (!account) return fallbackId ? `${fallbackId}${provider === 'claude' ? '' : ` · ${PROVIDER_NAME[provider]}`}` : tr('Conta desconhecida');
  if (provider === 'claude') return `${account.name}${account.email ? ` (${account.email})` : ''}`;
  const tag = showsProviderTag(provider, account.name) ? ` · ${PROVIDER_NAME[provider]}` : '';
  return `${account.name}${tag}${account.plan ? tr(' · plano {0}', [account.plan]) : ''}`;
}

/**
 * Texto do escritório vazio. Os atalhos ("atalhos c ou d") são só das contas do Claude Code, que vêm de aliases do
 * shell (a letra de uma conta do Codex ou do omp não é um atalho); o Codex e o omp só entram quando há uma conta deles.
 */
export function emptyOfficeHint(accounts: readonly Pick<AccountInfo, 'short' | 'provider'>[]): string {
  const keys = shortcutHint(accounts.filter((a) => providerOf(a) === 'claude'));
  const keyText = keys ? ` (${keys})` : '';
  const codex = accounts.some(isCodex);
  const omp = accounts.some(isOmp);
  if (codex && omp) return tr('Abra o Claude Code{0}, o Codex ou o omp em qualquer projeto e veja seu agente chegar.', [keyText]);
  if (omp) return tr('Abra o Claude Code{0} ou o omp em qualquer projeto e veja seu agente chegar.', [keyText]);
  if (codex) return tr('Abra o Claude Code{0} ou o Codex em qualquer projeto e veja seu agente chegar.', [keyText]);
  return tr('Abra o Claude Code em qualquer projeto{0} e veja seu agente chegar.', [keyText]);
}

/**
 * Algum pedido de permissão do Codex ou do omp esperando: o prazo é curto e o cartão conta os segundos (relógio de
 * 1 s). O Claude Code (hook de 5 min) não precisa.
 */
export function hasShortPermission(snap: Pick<OfficeSnapshot, 'agents'> | null): boolean {
  return !!snap?.agents.some((a) => a.permission && providerOf(a.permission) !== 'claude' && a.status !== 'offline' && a.status !== 'done');
}

/** Como ver o Codex ao vivo e aprovar pelo escritório (gaveta de um agente do Codex e ajuda). */
export const CODEX_LIVE_HINT = tr('Para ver o Codex ao vivo e aprovar pelo escritório: `npm run codex:install` e aprove os hooks em `/hooks` no Codex.');

/** Políticas de aprovação do Codex (`approval_policy`), quando o servidor as manda no lugar do modo de permissão. */
const CODEX_APPROVALS: Record<string, string> = {
  untrusted: tr('Pergunta antes de quase tudo'),
  'on-request': tr('Pergunta quando precisa'),
  'on-failure': tr('Pergunta quando um comando falha'),
  never: tr('Nunca pergunta'),
};

/** Aprovação de um agente do Codex em português (valor desconhecido passa como veio). */
export function codexApprovalLabel(policy: string | undefined): string {
  if (!policy) return '—';
  return CODEX_APPROVALS[policy] ?? policy;
}
