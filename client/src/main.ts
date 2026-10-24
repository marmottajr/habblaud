// Ponto de entrada do cliente: primeiro o dicionário do idioma ativo (só ele vai para o navegador), depois o app
// (client/src/app.ts), porque vários módulos chamam tr() ao carregar. Se o dicionário não carregar, fica em português.
import { getLocale, registerDictionary, type Locale } from '../../shared/i18n';

const LOADERS: Partial<Record<Locale, () => Promise<Readonly<Record<string, string>>>>> = {
  en: () => import('../../shared/locales/en').then((m) => m.EN),
  es: () => import('../../shared/locales/es').then((m) => m.ES),
  fr: () => import('../../shared/locales/fr').then((m) => m.FR),
};

// Teclado virtual: no iOS (e Android sem interactive-widget) ele só encolhe o visualViewport, e os painéis fixos com
// inset 0 ficam atrás dele. --kb = altura coberta embaixo; o terminal em tela cheia (styles.css) sobe por ela.
const vv = window.visualViewport;
if (vv) {
  const syncKb = () => document.documentElement.style.setProperty('--kb', `${Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop))}px`);
  vv.addEventListener('resize', syncKb);
  vv.addEventListener('scroll', syncKb);
  syncKb();
}

const locale = getLocale();
const load = LOADERS[locale];
const dictionary = load ? load().then((d) => registerDictionary(locale, d)).catch(() => undefined) : Promise.resolve();
void dictionary.then(() => import('./app')).then((app) => app.start());
