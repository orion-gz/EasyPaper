import en from './locales/en/settings.json' with { type: 'json' }
import ko from './locales/ko/settings.json' with { type: 'json' }

const lines = Object.keys(en).filter(key => key.startsWith('prompt.line.')).map(key => [en[key], ko[key]])

const korean = new Map(lines)
const english = new Map(lines.map(([en, ko]) => [ko, en]))

export function translatePromptLines(text, toKorean) {
  const dictionary = toKorean ? korean : english
  return text.split('\n').map(line => dictionary.get(line) ?? line).join('\n')
}
