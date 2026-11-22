const lines = [
  [
    "You are a professional document translator.",
    "문서 번역 전문가로서 다음 지침에 따라 번역하세요."
  ],
  [
    "Source language: {{SOURCE_LANGUAGE_NAME}} ({{SOURCE_LANGUAGE_TAG}})",
    "원문 언어: {{SOURCE_LANGUAGE_NAME}} ({{SOURCE_LANGUAGE_TAG}})"
  ],
  [
    "Target language: {{TARGET_LANGUAGE_NAME}} ({{TARGET_LANGUAGE_TAG}})",
    "번역 언어: {{TARGET_LANGUAGE_NAME}} ({{TARGET_LANGUAGE_TAG}})"
  ],
  [
    "Translation style:",
    "번역 문체:"
  ],
  [
    "Translation and preservation rules:",
    "번역 및 원문 보존 규칙:"
  ],
  [
    "- Translate the complete supplied source text. Never stop mid-sentence or omit content except where the rules explicitly require omission.",
    "- 제공된 원문 전체를 번역하세요. 규칙에서 명시적으로 생략하도록 한 경우 외에는 문장 중간에서 멈추거나 내용을 누락하지 마세요."
  ],
  [
    "- Use the supplied context only for consistency. Never repeat previous translated context in the output.",
    "- 앞선 문맥은 번역의 일관성을 위해서만 참고하세요. 이전 번역을 결과에 반복하지 마세요."
  ],
  [
    "- User-defined additions may be placed here without changing the fixed language instruction above.",
    "- 위의 고정 언어 지침을 유지하면서 이곳에 사용자 지침을 추가할 수 있습니다."
  ],
  [
    "[Source text]",
    "[원문]"
  ],
  [
    "[Translation in {{TARGET_LANGUAGE_NAME}}]",
    "[{{TARGET_LANGUAGE_NAME}} 번역]"
  ],
  [
    "- Include the original term in parentheses after translated technical terms.",
    "- 번역한 전문 용어 뒤에 원어를 괄호로 병기하세요."
  ],
  [
    "- Expand abbreviations on first use.",
    "- 약어가 처음 나오면 전체 명칭을 표기하세요."
  ],
  [
    "- Keep mathematical notation exactly as written.",
    "- 수학 기호를 원문 그대로 유지하세요."
  ],
  [
    "- Preserve citation markers and author-year references as written.",
    "- 인용 표시와 저자·연도 표기를 원문대로 유지하세요."
  ],
  [
    "- Keep numerical values and measurement units unchanged.",
    "- 수치와 측정 단위를 그대로 유지하세요."
  ],
  [
    "- Use the same translation for repeated technical terms.",
    "- 반복되는 전문 용어는 일관되게 번역하세요."
  ],
  [
    "- Preserve distinctions between tentative findings and established claims.",
    "- 잠정적인 결과와 확립된 주장을 구분하세요."
  ],
  [
    "- Retain figure and table numbers in cross-references.",
    "- 그림과 표를 참조할 때 번호를 유지하세요."
  ],
  [
    "- Preserve the paragraph breaks of the source text.",
    "- 원문의 문단 구분을 유지하세요."
  ]
]

const korean = new Map(lines)
const english = new Map(lines.map(([en, ko]) => [ko, en]))

export function translatePromptLines(text, toKorean) {
  const dictionary = toKorean ? korean : english
  return text.split('\n').map(line => dictionary.get(line) ?? line).join('\n')
}
