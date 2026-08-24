import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { UI_LOCALES } from '../src/locales/manifest.js'

const frontendRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const localeRoot = join(frontendRoot, 'src', 'locales')
const baseLocale = 'en'
const namespaces = readdirSync(join(localeRoot, baseLocale)).filter(name => name.endsWith('.json')).sort()
const localeDirs = readdirSync(localeRoot, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort()
if (JSON.stringify(localeDirs) !== JSON.stringify(Object.keys(UI_LOCALES).sort())) throw new Error('manifest locales and locale directories differ')
const placeholders = value => [...String(value).matchAll(/{{\s*([\w.-]+)\s*}}/g)].map(match => match[1]).sort()
const resources = new Map()
const uiSourceMap = JSON.parse(readFileSync(join(localeRoot, 'ui-source-map.json'), 'utf8'))
for (const locale of localeDirs) {
  const actual = readdirSync(join(localeRoot, locale)).filter(name => name.endsWith('.json')).sort()
  if (JSON.stringify(actual) !== JSON.stringify(namespaces)) throw new Error(locale + ': namespace set differs from ' + baseLocale)
  for (const namespace of namespaces) {
    const translated = JSON.parse(readFileSync(join(localeRoot, locale, namespace), 'utf8'))
    const base = JSON.parse(readFileSync(join(localeRoot, baseLocale, namespace), 'utf8'))
    if (!translated || Array.isArray(translated) || typeof translated !== 'object') throw new Error(locale + '/' + namespace + ': static JSON object required')
    const keys = Object.keys(base).sort(), translatedKeys = Object.keys(translated).sort()
    if (JSON.stringify(keys) !== JSON.stringify(translatedKeys)) throw new Error(locale + '/' + namespace + ': key set differs from ' + baseLocale)
    resources.set(locale + ':' + namespace.replace(/\.json$/, ''), translated)
    for (const key of keys) {
      const value = translated[key]
      if (typeof value !== 'string' || !value.trim()) throw new Error(locale + '/' + namespace + ':' + key + ' is empty or non-string')
      if (/<\/?[a-z][^>]*>|&(?:#\d+|#x[0-9a-f]+|[a-z][a-z0-9]+);/i.test(value)) throw new Error(locale + '/' + namespace + ':' + key + ' contains HTML')
      if (JSON.stringify(placeholders(base[key])) !== JSON.stringify(placeholders(value))) throw new Error(locale + '/' + namespace + ':' + key + ' has different interpolation parameters')
    }
    const stems = new Set(keys.flatMap(key => { const match = key.match(/^(.*)_(zero|one|two|few|many|other)$/); return match ? [match[1]] : [] }))
    for (const stem of stems) for (const category of new Intl.PluralRules(locale).resolvedOptions().pluralCategories) if (!Object.hasOwn(translated, stem + '_' + category)) throw new Error(locale + '/' + namespace + ':' + stem + ' missing plural category ' + category)
  }
}
const walk = dir => readdirSync(dir,{withFileTypes:true}).flatMap(entry => entry.isDirectory() ? walk(join(dir,entry.name)) : [join(dir,entry.name)])
const sourceFiles = [join(frontendRoot,'index.html'), ...walk(join(frontendRoot,'src')).filter(file => file.endsWith('.js'))]
const references = new Set()
for (const file of sourceFiles) {
  const source = readFileSync(file,'utf8')
  for (const regex of [/data-i18n(?:-placeholder|-title|-aria-label)?=["']([^"']+)["']/g, /\bt\(\s*["']([^"']+)["']/g]) for (const match of source.matchAll(regex)) if (!match[1].endsWith(':') && !match[1].endsWith('.')) references.add(match[1].includes(':') ? match[1] : 'common:' + match[1])
}
for (const reference of references) { const [namespace,key] = reference.split(/:(.+)/); const bundle=resources.get(baseLocale+':'+namespace)||{}; if (!Object.hasOwn(bundle,key) && !Object.hasOwn(bundle,key+'_other')) throw new Error('code references missing locale key '+reference) }
for (const namespaceFile of namespaces) {
  const namespace = namespaceFile.replace(/\.json$/, '')
  for (const key of Object.keys(resources.get(baseLocale+':'+namespace))) {
  const full = namespace+':'+key, pluralBase = full.replace(/_(zero|one|two|few|many|other)$/,'')
  const dynamic = namespace === 'errors' || key.startsWith('legacy.') || (namespace === 'common' && key.startsWith('language.'))
  if (!dynamic && !references.has(full) && !references.has(pluralBase)) throw new Error('unused locale key '+full)
}}
const contexts = JSON.parse(readFileSync(join(localeRoot,'developer-context.json'),'utf8'))
for (const namespaceFile of namespaces) { const namespace=namespaceFile.replace(/\.json$/,''); for (const key of Object.keys(resources.get(baseLocale+':'+namespace))) if (!contexts[namespace+':'+key]?.description) throw new Error('missing developer context '+namespace+':'+key) }
const hardcoded = new Set(), html = readFileSync(join(frontendRoot,'index.html'),'utf8').replace(/<!--[\s\S]*?-->/g,'')
for (const match of html.matchAll(/(?:title|placeholder|aria-label)="([^"]*[가-힣][^"]*)"|>([^<>]*[가-힣][^<>]*)</g)) { const value=(match[1]||match[2]||'').replace(/\s+/g,' ').trim(); if(value) hardcoded.add('index.html\0'+value) }
for (const file of sourceFiles.filter(file => file.endsWith('.js'))) {
  const rel=relative(frontendRoot,file), source=readFileSync(file,'utf8')
  for (const match of source.matchAll(/(['"])((?:\\.|(?!\1)[\s\S])*?)\1/g)) {
    const value=match[2].replace(/\s+/g,' ').trim()
    if(/[가-힣]/.test(value)&&value.length<1000) hardcoded.add(rel+'\0'+value)
  }
  const templateSource = source.replace(/\/\/[^\n]*/g, '')
  for (const templateMatch of templateSource.matchAll(/`([\s\S]*?)`/g)) {
    const template = templateMatch[1].replace(/\$\{[\s\S]*?\}/g, '')
    for (const match of template.matchAll(/(?:title|placeholder|aria-label)=["']([^"']*[가-힣][^"']*)["']|>([^<>]*[가-힣][^<>]*)</g)) {
      const value=(match[1]||match[2]||'').replace(/\s+/g,' ').trim()
      if(value) hardcoded.add(rel+'\0'+value)
    }
  }
}
const localizableLiteral = value => value && value.length <= 160 && !/[{}<>\\]/.test(value) && !value.includes('//') && !value.includes(String.fromCharCode(36,123)) && !/\b(function|const|let|return|await)\b/.test(value)
const unmapped = [...hardcoded].filter(item => { const value=item.split('\0')[1]; return localizableLiteral(value) && !uiSourceMap[value] })
if (unmapped.length) throw new Error('unmapped hardcoded Korean UI strings: '+unmapped.join(' | '))
for (const [sourceText, reference] of Object.entries(uiSourceMap)) {
  if (!/[가-힣]/.test(sourceText)) throw new Error('UI source map key is not Korean: '+sourceText)
  const [namespace,key] = reference.split(/:(.+)/)
  for (const locale of localeDirs) {
    const bundle=resources.get(locale+':'+namespace)||{}
    if (!Object.hasOwn(bundle,key)) throw new Error('UI source map references missing key '+locale+':'+reference)
    if (locale === 'en' && /[가-힣]/.test(bundle[key])) throw new Error('English UI translation contains Korean: '+reference)
  }
}
console.log('Validated '+localeDirs.length+' locales, '+namespaces.length+' namespaces, '+references.size+' references, and '+Object.keys(uiSourceMap).length+' mapped UI literals.')
