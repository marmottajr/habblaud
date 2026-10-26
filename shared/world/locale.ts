import type { Locale } from '../i18n';
import type { WorldLocale } from './protocol';

/** O servidor público do World ainda só aceita os quatro idiomas do protocolo. */
export function toWorldLocale(locale: Locale): WorldLocale {
  return locale === 'zh-CN' ? 'en' : locale;
}
