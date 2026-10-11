// Bloco "Rotinas" do painel de Demandas (equipe de agentes fixos; ver o README.md): fica ao lado de "Arquivadas" e
// é onde se define uma demanda de rotina. Rotina = uma demanda que se repete sozinha para um agente, em dias e hora
// marcados, a cada intervalo ou quando chega item novo. O servidor guarda e dispara (server/equipe/rotinas.ts); quem
// abre o terminal é o serviço do computador. A chave do escritório é pedida pelo painel de Demandas (ui/demandas.ts).
import type { RotinaInfo } from '../net/store';
import type { UiComponent, UiContext } from './context';
import { h, setHidden, setText } from './dom';

const DIAS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
const LETRAS = ['D', 'S', 'T', 'Q', 'Q', 'S', 'S'];
const CHEIOS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];

interface AgenteFixo {
  key: string;
  room: string;
  slug: string;
  label: string;
}

/** "seg, qua, sex às 09:00", "todo dia às 09:00" ou "a cada 4 horas". */
export function quandoTexto(r: Pick<RotinaInfo, 'dias' | 'hora' | 'intervaloMin' | 'gatilho'>): string {
  if (r.gatilho) return `quando chegar item novo em ${r.gatilho}`;
  if (r.intervaloMin) {
    if (r.intervaloMin % 1440 === 0) return r.intervaloMin === 1440 ? 'a cada dia' : `a cada ${r.intervaloMin / 1440} dias`;
    if (r.intervaloMin % 60 === 0) return r.intervaloMin === 60 ? 'a cada hora' : `a cada ${r.intervaloMin / 60} horas`;
    return `a cada ${r.intervaloMin} minutos`;
  }
  const dias = r.dias.length === 7 ? 'todo dia' : r.dias.length === 5 && r.dias.every((d) => d >= 1 && d <= 5) ? 'dias úteis' : r.dias.map((d) => DIAS[d]).join(', ');
  return `${dias} às ${r.hora}`;
}

/** "hoje 18:00", "amanhã 09:00" ou "seg 13/10 09:00". */
export function proximaTexto(ms: number, agora: number): string {
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms);
  const hoje = new Date(agora);
  const hora = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const dia = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((dia(d) - dia(hoje)) / 86_400_000);
  if (diff === 0) return `hoje ${hora}`;
  if (diff === 1) return `amanhã ${hora}`;
  return `${DIAS[d.getDay()]} ${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')} ${hora}`;
}

export class RotinasPainel implements UiComponent {
  /** O bloco inteiro (formulário e lista): o painel de Demandas o mostra na aba "Rotinas". */
  readonly el: HTMLElement;
  /** Sem chave, ou chave que não confere: o painel de Demandas mostra o campo da chave. */
  onSemChave: (() => void) | null = null;
  /** A lista mudou (carregou, criou, apagou): o painel de Demandas atualiza o número da aba. */
  onMudou: (() => void) | null = null;
  private ativo = false;
  private formTitle: HTMLElement;
  private agente: HTMLSelectElement;
  private prompt: HTMLTextAreaElement;
  private modoHorario: HTMLInputElement;
  private modoIntervalo: HTMLInputElement;
  private modoGatilho: HTMLInputElement;
  private horarioRow: HTMLElement;
  private intervaloRow: HTMLElement;
  private gatilhoRow: HTMLElement;
  private caminho: HTMLInputElement;
  private dias: HTMLButtonElement[];
  private hora: HTMLInputElement;
  private cada: HTMLInputElement;
  private unidade: HTMLSelectElement;
  private salvar: HTMLButtonElement;
  private cancelar: HTMLButtonElement;
  private msg: HTMLElement;
  private listTitle: HTMLElement;
  private list: HTMLElement;
  private rotinas: RotinaInfo[] = [];
  private editando: string | null = null;
  private agentesSig = '';
  private agentes: AgenteFixo[] = [];
  private busy = false;

  constructor(private ctx: UiContext) {
    const parar = (ev: Event) => ev.stopPropagation();
    this.formTitle = h('h3', { class: 'ui-rotp__sub', text: 'Nova demanda de rotina' });
    this.agente = h('select', { class: 'ui-rotp__field', attrs: { 'aria-label': 'Agente que vai executar' } });
    this.prompt = h('textarea', {
      class: 'ui-ask__text',
      attrs: { rows: 5, maxlength: 8000, placeholder: 'Escreva a demanda como você escreveria em "Nova demanda": o que o agente deve fazer toda vez que a rotina rodar…', 'aria-label': 'A demanda que se repete' },
      on: { keydown: parar },
    });
    this.modoHorario = h('input', { type: 'radio', attrs: { name: 'ui-rotp-modo', id: 'ui-rotp-horario', checked: true }, on: { change: () => this.syncModo() } });
    this.modoIntervalo = h('input', { type: 'radio', attrs: { name: 'ui-rotp-modo', id: 'ui-rotp-intervalo' }, on: { change: () => this.syncModo() } });
    this.modoGatilho = h('input', { type: 'radio', attrs: { name: 'ui-rotp-modo', id: 'ui-rotp-gatilho' }, on: { change: () => this.syncModo() } });
    this.caminho = h('input', {
      class: 'ui-rotp__field',
      type: 'text',
      attrs: { placeholder: '~/Documents/pedidos/novos.csv', 'aria-label': 'Pasta ou planilha do computador', autocomplete: 'off', spellcheck: 'false', maxlength: 400 },
      on: { keydown: parar },
    });
    this.gatilhoRow = h(
      'div',
      { class: 'ui-rotp__gatilho', hidden: true },
      this.caminho,
      h('p', { class: 'ui-ask__dica', text: 'Pasta: roda quando aparecer arquivo novo. Planilha .csv: quando aparecer linha nova. Vale só para o que chegar depois de salvar; o que já está lá não dispara.' }),
    );
    this.dias = LETRAS.map((n, i) => {
      const b = h('button', { class: 'ui-rot__dia', type: 'button', text: n, title: CHEIOS[i], attrs: { 'aria-pressed': i >= 1 && i <= 5 ? 'true' : 'false', 'aria-label': CHEIOS[i] } });
      b.addEventListener('click', () => b.setAttribute('aria-pressed', b.getAttribute('aria-pressed') === 'true' ? 'false' : 'true'));
      return b;
    });
    this.hora = h('input', { class: 'ui-rot__hora', type: 'time', attrs: { value: '09:00', 'aria-label': 'Hora' }, on: { keydown: parar } });
    this.horarioRow = h('div', { class: 'ui-rotp__quando' }, h('span', { class: 'ui-rot__dias' }, ...this.dias), h('span', { class: 'ui-muted', text: 'às' }), this.hora);
    this.cada = h('input', { class: 'ui-rot__hora ui-rotp__num', type: 'number', attrs: { min: 1, max: 999, value: 4, 'aria-label': 'Intervalo' }, on: { keydown: parar } });
    this.unidade = h('select', { class: 'ui-rotp__field ui-rotp__unidade', attrs: { 'aria-label': 'Unidade do intervalo' } }, h('option', { text: 'minutos', attrs: { value: 1 } }), h('option', { text: 'horas', attrs: { value: 60, selected: true } }), h('option', { text: 'dias', attrs: { value: 1440 } }));
    this.intervaloRow = h('div', { class: 'ui-rotp__quando', hidden: true }, h('span', { class: 'ui-muted', text: 'A cada' }), this.cada, this.unidade, h('span', { class: 'ui-muted', text: '(mínimo 15 minutos)' }));
    this.salvar = h('button', { class: 'ui-btn ui-ask__send', type: 'button', text: 'Salvar rotina', on: { click: () => void this.gravar() } });
    this.cancelar = h('button', { class: 'ui-btn', type: 'button', text: 'Cancelar edição', hidden: true, on: { click: () => this.limparForm() } });
    this.msg = h('p', { class: 'ui-ask__msg', role: 'status', hidden: true });

    const form = h(
      'div',
      { class: 'ui-rotp__form' },
      this.formTitle,
      h('label', { class: 'ui-rotp__label', text: 'Agente' }),
      this.agente,
      h('label', { class: 'ui-rotp__label', text: 'A demanda que se repete' }),
      this.prompt,
      h('label', { class: 'ui-rotp__label', text: 'Quando roda' }),
      h(
        'div',
        { class: 'ui-rotp__modos' },
        h('label', { class: 'ui-rot__label', attrs: { for: 'ui-rotp-horario' } }, this.modoHorario, h('span', { text: 'Em dias e hora marcados' })),
        h('label', { class: 'ui-rot__label', attrs: { for: 'ui-rotp-intervalo' } }, this.modoIntervalo, h('span', { text: 'A cada intervalo' })),
        h('label', { class: 'ui-rot__label', attrs: { for: 'ui-rotp-gatilho' } }, this.modoGatilho, h('span', { text: 'Quando chegar item novo' })),
      ),
      this.horarioRow,
      this.intervaloRow,
      this.gatilhoRow,
      h('div', { class: 'ui-ask__row' }, this.salvar, this.cancelar, this.msg),
    );

    this.listTitle = h('h3', { class: 'ui-rotp__sub', text: 'Rotinas' });
    this.list = h('div', { class: 'ui-rotp__list' });
    this.el = h(
      'div',
      { class: 'ui-rotp__painel', hidden: true },
      h('p', { class: 'ui-ask__dica', text: 'Uma demanda que se repete sozinha para o agente que você escolher. Na hora, o terminal dele abre, ele trabalha e fecha, e a demanda aparece em "Em andamento" como qualquer outra. O computador precisa estar ligado.' }),
      form,
      this.listTitle,
      this.list,
    );
  }

  /** Quantas rotinas existem (o número da aba). */
  get total(): number {
    return this.rotinas.length;
  }

  /** A aba "Rotinas" foi aberta: mostra o bloco e busca a lista. */
  mostrar(): void {
    this.ativo = true;
    setHidden(this.el, false);
    this.syncAgentes(true);
    void this.load();
  }

  esconder(): void {
    this.ativo = false;
    setHidden(this.el, true);
  }

  render(): void {
    if (this.ativo) this.syncAgentes(false);
  }

  /** Agentes fixos que estão no escritório (parados ou trabalhando), um por projeto e nome de arquivo. */
  private syncAgentes(forcar: boolean): void {
    const vistos = new Map<string, AgenteFixo>();
    for (const a of this.ctx.store.snapshot?.agents ?? []) {
      if (!a.staff || a.kind !== 'main') continue;
      const key = `${a.roomId}\n${a.staff}`;
      if (vistos.has(key) && !a.parked) continue;
      vistos.set(key, { key, room: a.roomId, slug: a.staff, label: `${a.name} · ${a.job ?? a.staff} (${this.ctx.store.room(a.roomId)?.name ?? a.roomId})` });
    }
    const lista = [...vistos.values()].sort((x, y) => x.label.localeCompare(y.label, 'pt-BR'));
    const sig = lista.map((a) => `${a.key}=${a.label}`).join('|');
    if (sig === this.agentesSig && !forcar) return;
    this.agentesSig = sig;
    this.agentes = lista;
    const atual = this.agente.value;
    this.agente.replaceChildren(...(lista.length ? lista.map((a) => h('option', { text: a.label, attrs: { value: a.key } })) : [h('option', { text: 'Nenhum agente fixo ainda (crie em "+ Novo agente", numa sala de equipe)', attrs: { value: '' } })]));
    if (lista.some((a) => a.key === atual)) this.agente.value = atual;
    this.salvar.disabled = !lista.length || this.busy;
    this.renderList();
  }

  private syncModo(): void {
    setHidden(this.horarioRow, !this.modoHorario.checked);
    setHidden(this.intervaloRow, !this.modoIntervalo.checked);
    setHidden(this.gatilhoRow, !this.modoGatilho.checked);
  }

  private aviso(text: string, kind: 'ok' | 'erro' | 'info' = 'info'): void {
    setText(this.msg, text);
    setHidden(this.msg, !text);
    this.msg.className = `ui-ask__msg ui-ask__msg--${kind}`;
  }

  /** Busca as rotinas. O painel de Demandas chama ao abrir (para o número da aba) e depois de receber a chave. */
  async load(): Promise<void> {
    const store = this.ctx.store;
    if (!store.equipeKey) {
      this.rotinas = [];
      this.renderList();
      return void this.onMudou?.();
    }
    const lista = await store.rotinas();
    // Chave que não confere (ou escritório fora do ar): o painel de Demandas pede de novo.
    if (lista === null && this.ativo) this.onSemChave?.();
    this.rotinas = lista ?? [];
    this.renderList();
    this.onMudou?.();
  }

  private nomeDe(r: RotinaInfo): string {
    return this.agentes.find((a) => a.room === r.room && a.slug === r.slug)?.label ?? `${r.slug} (agente fora do escritório)`;
  }

  private renderList(): void {
    const agora = Date.now();
    setText(this.listTitle, this.rotinas.length ? `Rotinas (${this.rotinas.length})` : 'Rotinas');
    if (!this.rotinas.length) {
      this.list.replaceChildren(h('p', { class: 'ui-rotp__vazio', text: this.ctx.store.equipeKey ? 'Nenhuma rotina ainda. Defina a primeira acima.' : '' }));
      return;
    }
    const acao = (texto: string, titulo: string, fn: () => void) => h('button', { class: 'ui-btn ui-rot__mini', type: 'button', text: texto, title: titulo, on: { click: fn } });
    this.list.replaceChildren(
      ...this.rotinas.map((r) =>
        h(
          'div',
          { class: `ui-rot__item${r.ativa ? '' : ' is-off'}${this.editando === r.id ? ' is-editing' : ''}` },
          h('div', { class: 'ui-rotp__quem', text: this.nomeDe(r) }),
          h('div', { class: 'ui-rotp__meta' }, h('strong', { text: quandoTexto(r) }), h('span', { text: !r.ativa ? ' · desligada' : r.gatilho ? (r.ultima ? ` · última vez: ${proximaTexto(r.ultima, agora)}` : ' · esperando chegar') : ` · próxima: ${proximaTexto(r.proxima, agora)}` })),
          h('p', { class: 'ui-rot__texto', text: r.pedido, title: r.pedido }),
          r.ultimoAviso ? h('p', { class: 'ui-rot__aviso', text: `Última vez: ${r.ultimoAviso}` }) : null,
          h(
            'div',
            { class: 'ui-rotp__acoes' },
            acao(r.ativa ? 'Ligada' : 'Desligada', r.ativa ? 'Clique para desligar' : 'Clique para ligar', () => void this.mudar(r.id, { ativa: !r.ativa })),
            acao('Rodar agora', r.gatilho ? 'Abre o terminal do agente com este prompt agora, sem esperar chegar item novo' : 'Abre o terminal do agente com este prompt agora, para testar', () => void this.mudar(r.id, { rodar: true }, 'Rodando agora: o terminal do agente vai abrir.')),
            acao('Editar', 'Carrega esta rotina no formulário acima', () => this.editar(r)),
            acao('Apagar', 'Apaga esta rotina', () => void this.mudar(r.id, { apagar: true })),
          ),
        ),
      ),
    );
  }

  private async mudar(id: string, mudanca: Record<string, unknown>, sucesso?: string): Promise<void> {
    const r = await this.ctx.store.mudarRotina(id, mudanca);
    if (!r.ok) this.aviso(r.error ?? 'Não foi possível alterar a rotina.', 'erro');
    else if (sucesso) this.aviso(sucesso, 'ok');
    if (mudanca.apagar && this.editando === id) this.limparForm();
    await this.load();
  }

  private editar(r: RotinaInfo): void {
    this.editando = r.id;
    setText(this.formTitle, 'Editando a demanda de rotina');
    setText(this.salvar, 'Salvar alterações');
    setHidden(this.cancelar, false);
    const key = `${r.room}\n${r.slug}`;
    if (this.agentes.some((a) => a.key === key)) this.agente.value = key;
    this.prompt.value = r.pedido;
    if (r.gatilho) {
      this.modoGatilho.checked = true;
      this.caminho.value = r.gatilho;
    } else if (r.intervaloMin) {
      this.modoIntervalo.checked = true;
      const un = r.intervaloMin % 1440 === 0 ? 1440 : r.intervaloMin % 60 === 0 ? 60 : 1;
      this.unidade.value = String(un);
      this.cada.value = String(r.intervaloMin / un);
    } else {
      this.modoHorario.checked = true;
      this.dias.forEach((b, i) => b.setAttribute('aria-pressed', String(r.dias.includes(i))));
      this.hora.value = r.hora;
    }
    this.syncModo();
    this.aviso('');
    this.renderList();
    this.prompt.focus();
  }

  private limparForm(): void {
    this.editando = null;
    setText(this.formTitle, 'Nova demanda de rotina');
    setText(this.salvar, 'Salvar rotina');
    setHidden(this.cancelar, true);
    this.prompt.value = '';
    this.renderList();
  }

  private async gravar(): Promise<void> {
    if (this.busy) return;
    const store = this.ctx.store;
    if (!store.equipeKey) {
      this.onSemChave?.();
      return this.aviso('Cole a chave do escritório, no alto do painel, para salvar.', 'erro');
    }
    const agente = this.agentes.find((a) => a.key === this.agente.value);
    if (!agente) return this.aviso('Escolha o agente.', 'erro');
    const pedido = this.prompt.value.trim();
    if (!pedido) return this.aviso('Escreva a demanda que vai se repetir.', 'erro');
    if (this.modoGatilho.checked && !this.caminho.value.trim()) return this.aviso('Diga a pasta ou a planilha a vigiar.', 'erro');
    const quando: { dias?: number[]; hora?: string; intervaloMin?: number; gatilho?: string } = this.modoGatilho.checked
      ? { gatilho: this.caminho.value.trim() }
      : this.modoHorario.checked
        ? { dias: this.dias.map((b, i) => (b.getAttribute('aria-pressed') === 'true' ? i : -1)).filter((i) => i >= 0), hora: this.hora.value, intervaloMin: 0, gatilho: '' }
        : { intervaloMin: Math.round(Number(this.cada.value) * Number(this.unidade.value)), gatilho: '' };
    this.busy = true;
    this.salvar.disabled = true;
    this.aviso('Salvando…');
    try {
      const dados = { room: agente.room, slug: agente.slug, pedido, ...quando };
      const r = this.editando ? await store.mudarRotina(this.editando, dados) : await store.criarRotina(dados);
      if (!r.ok) return this.aviso(r.error ?? 'Não foi possível salvar a rotina.', 'erro');
      const editou = !!this.editando;
      this.limparForm();
      this.aviso(editou ? 'Rotina alterada.' : 'Rotina salva.', 'ok');
      await this.load();
    } finally {
      this.busy = false;
      this.salvar.disabled = !this.agentes.length;
    }
  }
}
