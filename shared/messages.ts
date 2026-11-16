// Mensagens pelo escritório (POST /api/messages): o que o servidor, o demo e a página têm em comum.
// Código puro: sem APIs de Node nem de DOM.
import { maskSecrets, truncate, type ActivityDescription } from './activity';
import { tr } from './i18n';

/** Tamanho máximo de uma mensagem (caracteres). */
export const MESSAGE_MAX = 20_000;
/** `Activity.tool` da atividade "Mensagem pelo Habblaud" (não é uma ferramenta do agente: é o seu texto entrando). */
export const MESSAGE_TOOL = 'HabblaudMessage';
/** Detalhe da atividade: o começo do texto, mascarado e cortado (o texto inteiro vai só para a sessão). */
const DETAIL_MAX = 300;

/** Imagens por mensagem (anexar, Ctrl+V ou arrastar). */
export const MESSAGE_IMAGES_MAX = 6;
/** Tipos de imagem aceitos (o servidor confere também os primeiros bytes do arquivo). */
export const MESSAGE_IMAGE_TYPES: readonly string[] = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
/** Lado maior de uma imagem depois da redução no navegador (prints em 4K e fotos do celular gastam menos contexto). */
export const MESSAGE_IMAGE_SIDE = 2000;

/**
 * Atividade "Mensagem pelo Habblaud" de uma mensagem entregue à sessão (entrou nela ou na fila dela: não quer dizer
 * que o agente já leu). `images` = quantas imagens foram junto.
 */
export function describeMessage(text: string, images = 0): ActivityDescription & { tool: string } {
  const detail = truncate(maskSecrets(text.slice(0, DETAIL_MAX * 4)), DETAIL_MAX);
  const label = images === 1 ? tr('Mensagem pelo Habblaud · 1 imagem') : images > 1 ? tr('Mensagem pelo Habblaud · {0} imagens', [images]) : tr('Mensagem pelo Habblaud');
  return { kind: 'communicate', icon: images ? '🖼️' : '✉️', text: label, tool: MESSAGE_TOOL, ...(detail ? { detail } : {}) };
}

/**
 * Texto que vai à sessão com imagens: o que você escreveu e, no fim, os caminhos das imagens gravadas no computador,
 * com o pedido para o agente abri-las (a ferramenta de leitura do Claude Code e a do Codex mostram imagens). Sem texto,
 * só o pedido para ver as imagens.
 */
export function messageWithImages(text: string, paths: readonly string[]): string {
  const body = text.trim();
  if (!paths.length) return body;
  const head =
    paths.length === 1
      ? tr('[Imagem anexada pelo Habblaud: abra com a ferramenta de leitura para ver]')
      : tr('[{0} imagens anexadas pelo Habblaud: abra cada uma com a ferramenta de leitura para ver]', [paths.length]);
  const list = paths.map((p) => `- ${p}`).join('\n');
  const intro = body || (paths.length === 1 ? tr('Veja a imagem que mandei.') : tr('Veja as imagens que mandei.'));
  return `${intro}\n\n${head}\n${list}`;
}
