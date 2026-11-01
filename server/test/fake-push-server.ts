// Servidor de push de mentira, na parte que RECUSA (para testes). Nada aqui sai da máquina.
//
// Um duplo que responde 201 a qualquer cabeçalho mede o nosso código contra as nossas suposições, não contra as
// regras de quem recebe. Foi o que deixou passar um `Topic` que o servidor da Apple recusa com
// `400 BadWebPushTopic`: a suíte ficou verde e o aviso não chegava ao celular.

/**
 * O que o servidor de push recusa num `Topic`: alfabeto base64url e no máximo 32 caracteres (RFC 8030 §5.4), mais a
 * parte que a norma não escreve — o valor tem de **decodificar** como base64, e um comprimento ≡ 1 (mod 4) nunca
 * decodifica. Devolve o `reason` da recusa, ou `undefined` quando o cabeçalho passa.
 */
export function recusaDeTopic(topic: string | undefined): string | undefined {
  if (topic === undefined) return undefined; // sem cabeçalho não há o que recusar
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(topic)) return 'BadWebPushTopic';
  if (topic.length % 4 === 1) return 'BadWebPushTopic';
  return undefined;
}

export interface FakePushCall {
  url: string;
  headers: Record<string, string>;
  body: Uint8Array;
}

/**
 * `fetch` que guarda cada POST e responde como a Apple responde: 201 quando os cabeçalhos passam, e
 * `400 {"reason":"BadWebPushTopic"}` quando o `Topic` não passa. `status` troca a resposta do caso bom, para os
 * testes que medem o que o serviço faz com um 4xx ou um 410.
 */
export function fakePushServer(status = 201): { calls: FakePushCall[]; fetch: typeof globalThis.fetch } {
  const calls: FakePushCall[] = [];
  const fetch = (async (url: string | URL, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url: String(url), headers, body: init?.body as Uint8Array });
    const recusa = recusaDeTopic(headers.Topic);
    if (recusa) return { status: 400, ok: false, text: async () => `{"reason":"${recusa}"}` } as Response;
    return { status, ok: status < 300, text: async () => '' } as Response;
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetch };
}
