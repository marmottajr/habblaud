// Para onde é que o servidor aceita mandar um push: lista fechada de anfitriões, por sufixo.
//
// Um endpoint de push é um endereço que o navegador dá e que o servidor passa a usar como alvo de `POST` a cada
// aviso. Sem lista, qualquer `https://` serve: quem alcançar a porta local inscreve um endereço seu e fica com um
// canal de saída que sobrevive a reinícios, ou aponta-o a um serviço da rede interna e usa o servidor como sonda
//. A lista é verificada na inscrição E antes de cada envio,
// para uma linha gravada antes desta verificação não escapar por já estar no ficheiro.
//
// Alargável por `HABBLAUD_PUSH_HOSTS` (vírgulas), para o dia em que um navegador mudar de domínio.

/** Serviços de push dos navegadores que existem hoje. Sufixos: o anfitrião real leva prefixos variáveis. */
export const DEFAULT_PUSH_HOSTS: readonly string[] = ['.push.apple.com', 'fcm.googleapis.com', '.push.services.mozilla.com'];

/** Prazo de cada envio. Sem isto herda-se o do `undici`, da ordem dos minutos, e uma inscrição lenta segura a fila. */
export const SEND_TIMEOUT_MS = 10_000;

export function parsePushHosts(raw: string | undefined): string[] {
  const extra = (raw ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  return [...DEFAULT_PUSH_HOSTS, ...extra];
}

/**
 * O endpoint é uma URL `https://` com anfitrião aceito? Devolve a URL quando sim, para quem chama não a construir
 * outra vez. **Nunca lança**: é a função que fecha a falha em que um `new URL()` fora de um `try` derrubava
 * o processo a partir de uma linha de HTTP.
 */
export function parsePushEndpoint(endpoint: unknown, hosts: readonly string[] = DEFAULT_PUSH_HOSTS): URL | undefined {
  if (typeof endpoint !== 'string' || !endpoint || endpoint.length > 1024) return undefined;
  if (/[\s\u0000-\u001f]/.test(endpoint)) return undefined;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' || !url.hostname) return undefined;
  const host = url.hostname.toLowerCase();
  const ok = hosts.some((h) => (h.startsWith('.') ? host.endsWith(h) : host === h));
  return ok ? url : undefined;
}

/** Só o teste de forma, sem a lista: é o que a leitura do ficheiro usa para não deixar entrar lixo antigo. */
export function isWellFormedEndpoint(endpoint: unknown): boolean {
  if (typeof endpoint !== 'string' || !endpoint || endpoint.length > 1024) return false;
  if (/[\s\u0000-\u001f]/.test(endpoint)) return false;
  try {
    const url = new URL(endpoint);
    return url.protocol === 'https:' && !!url.hostname;
  } catch {
    return false;
  }
}
