// Only pass application-authored Korean UI copy, never document titles or content.
export function documentUiCopy(copy, mode = 'research') {
  if (mode !== 'general') return copy
  return copy.replaceAll('논문을', '문서를')
    .replaceAll('논문은', '문서는')
    .replace(/논문이(?=\s|$)/g, '문서가')
    .replaceAll('논문', '문서')
}
