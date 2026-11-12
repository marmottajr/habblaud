// Ids e caminhos dos subagentes do Kiro CLI 3.x (v3paths.ts): o subSessionId vem do transcript, então nada de "/" ou "..".
import { describe, expect, it } from 'vitest';
import { kiroV3SubAgentId, kiroV3SubTranscriptFile, parseKiroV3SubAgentId } from './v3paths';

describe('ids de subagente do 3.x', () => {
  it('<sessionId>:<subSessionId> vai e volta', () => {
    const id = kiroV3SubAgentId('cli_00000000-0000-0000-0000-000000000000_abc', '11111111-1111-1111-1111-111111111111');
    expect(parseKiroV3SubAgentId(id)).toEqual({ sessionId: 'cli_00000000-0000-0000-0000-000000000000_abc', subSessionId: '11111111-1111-1111-1111-111111111111' });
  });

  it('recusa ids que sairiam da pasta ou estão vazios', () => {
    for (const bad of ['s:../x', 's:a/b', 's:a..b', 's:', ':x', 'semdoispontos', '../s:x', 's:a:b']) expect(parseKiroV3SubAgentId(bad), bad).toBeUndefined();
    for (const bad of ['../evil', 'a/b', '..', '', '/abs']) expect(kiroV3SubTranscriptFile('/k/sessions/h/s', bad), bad).toBeUndefined();
    expect(kiroV3SubTranscriptFile('/k/sessions/h/s', 'ok-1')).toBe('/k/sessions/h/s/sub-executions/ok-1.jsonl');
  });
});
