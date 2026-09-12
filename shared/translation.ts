export const translationLanguages = { 'zh-TW': '繁體中文', en: 'English', ja: '日本語' } as const;
export type TranslationTarget = keyof typeof translationLanguages;
export function translationLink(value: string, target: TranslationTarget = 'zh-TW', kind: 'text' | 'website' = 'text'): string {
  if (!Object.hasOwn(translationLanguages, target)) throw new Error('Unknown translation language');
  if (kind === 'website') {
    const source = new URL(value);
    if (source.protocol !== 'https:' || source.username || source.password) throw new Error('Invalid public source link');
    return `https://translate.google.com/translate?${new URLSearchParams({ sl: 'auto', tl: target, u: source.href })}`;
  }
  return `https://translate.google.com/?${new URLSearchParams({ sl: 'auto', tl: target, text: value.slice(0, 2000), op: 'translate' })}`;
}
