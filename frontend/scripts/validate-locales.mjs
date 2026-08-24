import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const localeRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'locales')
const baseLocale = 'en'
const namespaces = readdirSync(join(localeRoot, baseLocale)).filter((name) => name.endsWith('.json')).sort()
const localeDirs = readdirSync(localeRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)

function placeholders(value) {
  return [...String(value).matchAll(/{{\s*([\w.-]+)\s*}}/g)].map((match) => match[1]).sort()
}

for (const locale of localeDirs) {
  const actualNamespaces = readdirSync(join(localeRoot, locale)).filter((name) => name.endsWith('.json')).sort()
  if (JSON.stringify(actualNamespaces) !== JSON.stringify(namespaces)) {
    throw new Error(locale + ': namespace set differs from ' + baseLocale)
  }
  for (const namespace of namespaces) {
    const base = JSON.parse(readFileSync(join(localeRoot, baseLocale, namespace), 'utf8'))
    const translated = JSON.parse(readFileSync(join(localeRoot, locale, namespace), 'utf8'))
    const baseKeys = Object.keys(base).sort()
    const translatedKeys = Object.keys(translated).sort()
    if (JSON.stringify(baseKeys) !== JSON.stringify(translatedKeys)) {
      throw new Error(locale + '/' + namespace + ': key set differs from ' + baseLocale)
    }
    for (const key of baseKeys) {
      if (!translated[key]) throw new Error(locale + '/' + namespace + ':' + key + ' is empty')
      if (JSON.stringify(placeholders(base[key])) !== JSON.stringify(placeholders(translated[key]))) {
        throw new Error(locale + '/' + namespace + ':' + key + ' has different interpolation parameters')
      }
      if (key.endsWith('_one') && !Object.hasOwn(translated, key.replace(/_one$/, '_other'))) {
        throw new Error(locale + '/' + namespace + ':' + key + ' is missing _other plural form')
      }
    }
  }
}

console.log('Validated ' + localeDirs.length + ' locales and ' + namespaces.length + ' namespaces.')
