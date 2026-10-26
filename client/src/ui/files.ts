// Navegador de arquivos da pasta de trabalho (botão "Arquivos" na gaveta da sala e na do agente): janela com as pastas
// e os arquivos da sala (e de ~/projetos). Entra nas pastas, abre imagem/PDF/vídeo/texto/página no visualizador e baixa
// qualquer arquivo. Só leitura. Dados de GET /api/files, /api/files/list e /api/files/raw (server/http/files.ts);
// partes puras em files-model.ts. Só com o terminal liberado (access().files).
import { tr } from '../../../shared/i18n';
import type { FileEntry, FileRoot } from '../../../shared/types';
import type { UiComponent, UiContext } from './context';
import { h, iconButton, setText } from './dom';
import { crumbs, FILES_URL, listUrl, parseListing, parseRoots, rawUrl, rootFor } from './files-model';
import { relativeTime } from './format';
import { ICONS } from './icons';
import { formatBytes } from './spawn';

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
  const body: unknown = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? tr('erro {0}', [res.status]));
  return body;
}

export class FileBrowser implements UiComponent {
  readonly el: HTMLDialogElement;
  private readonly rootSelect: HTMLSelectElement;
  private readonly crumbsEl: HTMLElement;
  private readonly listEl: HTMLElement;
  private readonly viewer: HTMLDialogElement;
  private readonly viewerTitle: HTMLElement;
  private readonly viewerDownload: HTMLAnchorElement;
  private readonly viewerBody: HTMLElement;
  private roots: FileRoot[] = [];
  private root: FileRoot | undefined;
  private seq = 0;

  constructor(private readonly ctx: UiContext) {
    this.rootSelect = h('select', { class: 'ui-files__root', attrs: { 'aria-label': tr('Pasta de trabalho') } });
    this.rootSelect.addEventListener('change', () => {
      this.root = this.roots[this.rootSelect.selectedIndex];
      if (this.root) void this.list(this.root.path);
    });
    this.crumbsEl = h('div', { class: 'ui-files__crumbs' });
    this.listEl = h('ul', { class: 'ui-files__list' });
    this.el = h(
      'dialog',
      { class: 'ui-files', attrs: { 'aria-label': tr('Arquivos') } },
      h(
        'div',
        { class: 'ui-files__body' },
        h(
          'div',
          { class: 'ui-files__bar' },
          Object.assign(h('span', { class: 'ui-files__icon' }), { innerHTML: ICONS.cabinet }),
          h('strong', { class: 'ui-files__title', text: tr('Arquivos') }),
          this.rootSelect,
          iconButton(ICONS.close, tr('Fechar'), () => this.el.close(), 'ui-icon-btn--sm'),
        ),
        this.crumbsEl,
        this.listEl,
      ),
    ) as HTMLDialogElement;

    this.viewerTitle = h('span', { class: 'ui-deliv-viewer__title' });
    this.viewerDownload = h('a', { class: 'ui-btn ui-deliv-viewer__open', text: tr('Baixar'), attrs: { download: '' } }) as HTMLAnchorElement;
    this.viewerBody = h('div', { class: 'ui-deliv-viewer__body' });
    this.viewer = h(
      'dialog',
      { class: 'ui-deliv-viewer', attrs: { 'aria-label': tr('Arquivo') } },
      h('div', { class: 'ui-deliv-viewer__bar' }, h('div', { class: 'ui-deliv-viewer__label' }, this.viewerTitle), this.viewerDownload, iconButton(ICONS.close, tr('Fechar'), () => this.viewer.close(), 'ui-icon-btn--sm')),
      this.viewerBody,
    ) as HTMLDialogElement;
    this.viewer.addEventListener('close', () => this.viewerBody.replaceChildren());
    // O visualizador mora dentro da janela: só `this.el` entra no DOM (ui/index.ts), e showModal() exige estar no documento.
    this.el.append(this.viewer);
  }

  /** Só mantém o estado: quem decide mostrar o botão é a gaveta. */
  render(): void {}

  /** Abre a janela na pasta da sala (ou na primeira raiz). */
  async open(roomId?: string): Promise<void> {
    if (!this.el.open) this.el.showModal();
    const seq = ++this.seq;
    this.showMessage(tr('Carregando…'));
    try {
      const roots = parseRoots(await getJson(FILES_URL));
      if (seq !== this.seq) return;
      this.roots = roots;
      this.rootSelect.replaceChildren(...roots.map((r) => h('option', { text: r.roomId ? r.label : tr('projetos') })));
      this.root = rootFor(roots, roomId);
      if (!this.root) {
        this.crumbsEl.replaceChildren();
        this.showMessage(tr('Nenhuma pasta de trabalho por aqui ainda.'));
        return;
      }
      this.rootSelect.selectedIndex = roots.indexOf(this.root);
      await this.list(this.root.path);
    } catch (err) {
      if (seq === this.seq) this.showMessage(tr('Não deu para abrir: {0}', [(err as Error).message]));
    }
  }

  private showMessage(text: string): void {
    this.listEl.replaceChildren(h('li', { class: 'ui-files__msg', text }));
  }

  private async list(dir: string): Promise<void> {
    const seq = ++this.seq;
    this.showMessage(tr('Carregando…'));
    try {
      const listing = parseListing(await getJson(listUrl(dir)));
      if (seq !== this.seq) return; // clique rápido em outra pasta: esta resposta ficou velha
      if (!listing) throw new Error(tr('resposta inesperada'));
      const root = this.root;
      this.crumbsEl.replaceChildren(
        ...(root ? crumbs(root, listing.path) : []).map((c, i, all) =>
          h('button', { class: 'ui-files__crumb', type: 'button', text: c.label, attrs: { 'aria-current': i === all.length - 1 ? 'location' : undefined }, on: { click: () => void this.list(c.path) } }),
        ),
      );
      const rows = listing.entries.map((e) => this.row(listing.path, e));
      if (!rows.length) rows.push(h('li', { class: 'ui-files__msg', text: tr('Pasta vazia.') }));
      if (listing.truncated) rows.push(h('li', { class: 'ui-files__msg', text: tr('Mostrando os primeiros {0} itens desta pasta.', [listing.entries.length]) }));
      this.listEl.replaceChildren(...rows);
      this.listEl.scrollTop = 0;
    } catch (err) {
      if (seq === this.seq) this.showMessage(tr('Não deu para abrir: {0}', [(err as Error).message]));
    }
  }

  private row(dir: string, e: FileEntry): HTMLElement {
    const full = dir + (dir.includes('\\') && !dir.includes('/') ? '\\' : '/') + e.name;
    const icon = Object.assign(h('span', { class: 'ui-files__ico' }), { innerHTML: e.type === 'dir' ? ICONS.folder : ICONS.file });
    const name = h('span', { class: 'ui-files__name', text: e.name, title: e.name });
    const meta = h('span', { class: 'ui-files__meta', text: [e.type === 'file' ? formatBytes(e.size) : '', relativeTime(e.mtime, this.ctx.now())].filter(Boolean).join(' · ') });
    if (e.type === 'dir') {
      return h('li', { class: 'ui-files__item' }, h('button', { class: 'ui-files__open', type: 'button', on: { click: () => void this.list(full) } }, icon, name, meta));
    }
    const kind = e.kind;
    const main = kind
      ? h('button', { class: 'ui-files__open', type: 'button', title: tr('Ver'), on: { click: () => this.view(full, e.name, kind) } }, icon, name, meta)
      : h('div', { class: 'ui-files__open' }, icon, name, meta);
    return h('li', { class: 'ui-files__item' }, main, h('a', { class: 'ui-btn', text: tr('Baixar'), attrs: { href: rawUrl(full, true), download: e.name } }));
  }

  private view(path: string, name: string, kind: NonNullable<FileEntry['kind']>): void {
    const url = rawUrl(path, false);
    setText(this.viewerTitle, name);
    this.viewerDownload.href = rawUrl(path, true);
    this.viewerDownload.download = name;
    let body: HTMLElement;
    if (kind === 'image') body = h('img', { class: 'ui-deliv-viewer__img', attrs: { src: url, alt: name } });
    else if (kind === 'video') body = h('video', { class: 'ui-deliv-viewer__video', attrs: { src: url, controls: true, playsinline: true } });
    else if (kind === 'pdf' || kind === 'page') body = h('iframe', { class: 'ui-deliv-viewer__frame', attrs: { src: url, title: name } });
    else {
      const pre = h('pre', { class: 'ui-deliv-viewer__text', text: tr('Carregando…') });
      body = pre;
      void fetch(url, { credentials: 'same-origin' })
        .then(async (r) => (r.ok ? r.text() : Promise.reject(new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? tr('erro {0}', [r.status])))))
        .then((t) => setText(pre, t.slice(0, 200_000)), (err: Error) => setText(pre, tr('Não deu para abrir: {0}', [err.message])));
    }
    if (body instanceof HTMLImageElement || body instanceof HTMLIFrameElement) {
      body.addEventListener('error', () => this.viewerBody.replaceChildren(h('p', { class: 'ui-deliv-viewer__err', text: tr('Não deu para abrir este arquivo.') })));
    }
    this.viewerBody.replaceChildren(body);
    if (!this.viewer.open) this.viewer.showModal();
  }
}
