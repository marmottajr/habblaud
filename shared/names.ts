import { nameKey, parseCharacterName } from './appearance';
import { hash32 } from './hash';

export interface PersonName {
  name: string;
  look: 'f' | 'm';
}

// Nomes brasileiros para os personagens. Sem duplicatas e sem variações quase iguais
// (ex.: Thiago/Tiago), para que cada personagem seja inconfundível no escritório.
const F = [
  'Ana', 'Beatriz', 'Camila', 'Daniela', 'Eduarda', 'Fernanda', 'Gabriela', 'Helena', 'Isabela', 'Júlia',
  'Larissa', 'Mariana', 'Natália', 'Olívia', 'Paula', 'Rebeca', 'Sofia', 'Tatiana', 'Valentina', 'Yasmin',
  'Alice', 'Bianca', 'Cecília', 'Débora', 'Elisa', 'Flávia', 'Giovana', 'Heloísa', 'Iara', 'Jéssica',
  'Lívia', 'Manuela', 'Melissa', 'Nina', 'Priscila', 'Rafaela', 'Sabrina', 'Teresa', 'Vitória', 'Zoe',
  'Aline', 'Bruna', 'Clara', 'Estela', 'Fabiana', 'Glória', 'Ingrid', 'Joana', 'Kátia', 'Lara',
  'Maitê', 'Mirela', 'Noemi', 'Pietra', 'Renata', 'Simone', 'Sara', 'Vanessa', 'Luana', 'Marina',
];
const M = [
  'Arthur', 'Bruno', 'Caio', 'Diego', 'Enzo', 'Felipe', 'Gustavo', 'Henrique', 'Igor', 'João',
  'Kauã', 'Lucas', 'Mateus', 'Nicolas', 'Otávio', 'Pedro', 'Rafael', 'Samuel', 'Thiago', 'Vinícius',
  'Bernardo', 'Danilo', 'Davi', 'Emanuel', 'Fábio', 'Gael', 'Heitor', 'Hugo', 'Joaquim', 'Jorge',
  'Leonardo', 'Lorenzo', 'Luan', 'Marcelo', 'Murilo', 'Noah', 'Otto', 'Raul', 'Renato', 'Ricardo',
  'Rodrigo', 'Sérgio', 'Theo', 'Tomás', 'Ulisses', 'Vicente', 'Wagner', 'Yuri', 'Augusto', 'Benício',
  'César', 'Douglas', 'Elias', 'Francisco', 'Guilherme', 'Ícaro', 'Jonas', 'Leandro', 'Miguel', 'Paulo',
];

export const NAME_POOL: readonly PersonName[] = Object.freeze(
  // Intercala para que nomes vizinhos no pool alternem a dica visual.
  F.flatMap((f, i) => [{ name: f, look: 'f' as const }, ...(M[i] ? [{ name: M[i], look: 'm' as const }] : [])]),
);

/**
 * Escolhe um nome determinístico para `id`, evitando os já usados.
 * Se o pool esgotar, acrescenta um sufixo numérico ("Ana 2").
 */
export function pickName(id: string, used: ReadonlySet<string>): PersonName {
  const n = NAME_POOL.length;
  const start = hash32(id) % n;
  for (let i = 0; i < n; i++) {
    const cand = NAME_POOL[(start + i) % n];
    if (!used.has(cand.name)) return cand;
  }
  const base = NAME_POOL[start];
  return { name: uniqueName(base.name, used), look: base.look };
}

/** `base` como está, ou com sufixo numérico ("Revisor 2") enquanto o nome estiver em uso. */
export function uniqueName(base: string, used: ReadonlySet<string>): string {
  for (let k = 1; ; k++) {
    const name = k === 1 ? base : `${base} ${k}`;
    if (!used.has(name)) return name;
  }
}

function capitalize(word: string): string {
  const letters = [...word];
  return letters[0].toLocaleUpperCase('pt-BR') + letters.slice(1).join('');
}

/**
 * Nome do personagem a partir do tipo do subagente: "code-reviewer" → "Code Reviewer", "revisor" → "Revisor".
 * null quando o tipo não serve como nome (vazio, só pontuação, ou maior que NAME_MAX), e aí vale o sorteio.
 * A dica visual vem do pool quando o nome é um dos de lá, senão do hash do nome: estável entre reinícios.
 */
export function nameFromType(type: string): PersonName | null {
  const words = type.normalize('NFC').split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (!words.length) return null;
  const name = words.map(capitalize).join(' ');
  if (parseCharacterName(name) !== name) return null;
  const key = nameKey(name);
  const pooled = NAME_POOL.find((p) => nameKey(p.name) === key);
  return { name, look: pooled?.look ?? NAME_POOL[hash32(key) % NAME_POOL.length].look };
}
