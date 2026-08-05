const API_BASE = '/api'

export async function uploadPDF(file, options, onProgress) {
  const formData = new FormData()
  formData.append('file', file)

  const { targetLang, style, ignoreMath, ignoreTable, ignoreRefs, translationMode } = options
  const query = `?target_lang=${encodeURIComponent(targetLang)}&style=${style}&ignore_math=${ignoreMath}&ignore_table=${ignoreTable}&ignore_refs=${ignoreRefs}&translation_mode=${encodeURIComponent(translationMode || 'auto')}`

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', `${API_BASE}/upload${query}`)

    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) {
        onProgress(Math.round((e.loaded / e.total) * 100))
      }
    })

    xhr.addEventListener('load', () => {
      if (xhr.status === 200) {
        resolve(JSON.parse(xhr.responseText))
      } else {
        try {
          const err = JSON.parse(xhr.responseText)
          reject(new Error(err.detail || '업로드 실패'))
        } catch {
          reject(new Error('업로드 실패'))
        }
      }
    })

    xhr.addEventListener('error', () => reject(new Error('네트워크 오류')))
    xhr.send(formData)
  })
}

export async function checkHealth() {
  const res = await fetch(`${API_BASE}/health`)
  return res.json()
}

export async function fetchCliAvailability() {
  const res = await fetch(`${API_BASE}/availability`)
  if (!res.ok) throw new Error('CLI 상태 조회 실패')
  return res.json()
}

export async function getSession(sessionId) {
  const res = await fetch(`${API_BASE}/session/${sessionId}`)
  if (!res.ok) throw new Error('세션 조회 실패')
  return res.json()
}

export async function getTranslationStatus(sessionId) {
  const res = await fetch(`${API_BASE}/translation-status/${sessionId}`)
  if (!res.ok) throw new Error('상태 조회 실패')
  return res.json()
}

/**
 * SSE 스트리밍으로 페이지 번역을 수신합니다.
 * @param {string} sessionId
 * @param {number} pageNum
 * @param {object} options - {targetLang, style, ignoreMath, ignoreTable, ignoreRefs}
 * @param {function} onToken - 토큰이 수신될 때마다 호출
 * @param {function} onDone - 완료 시 호출 (cached, sentences)
 * @param {function} onError - 오류 시 호출
 * @returns {function} abort - 번역 중단 함수
 */
export function streamTranslation(sessionId, pageNum, options, onToken, onDone, onError) {
  const controller = new AbortController()
  const { targetLang, style, ignoreMath, ignoreTable, ignoreRefs } = options
  const query = `?target_lang=${encodeURIComponent(targetLang)}&style=${style}&ignore_math=${ignoreMath}&ignore_table=${ignoreTable}&ignore_refs=${ignoreRefs}`

  fetch(`${API_BASE}/translate/${sessionId}/${pageNum}${query}`, {
    signal: controller.signal,
  })
    .then(async (res) => {
      if (!res.ok) {
        const err = await res.json()
        onError(new Error(err.detail || '번역 실패'))
        return
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { value, done } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() // 미완성 줄 보류

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const jsonStr = line.slice(6).trim()
          if (!jsonStr) continue

          try {
            const data = JSON.parse(jsonStr)
            if (data.error) {
              onError(new Error(data.error))
              return
            }
            if (data.content) {
              onToken(data.content, data.cached || false)
            }
            if (data.done) {
              onDone(data.cached || false, data.sentences || [])
              return
            }
          } catch (e) {
            console.warn('SSE 파싱 오류:', e)
          }
        }
      }
    })
    .catch((err) => {
      if (err.name !== 'AbortError') {
        onError(err)
      }
    })

  return () => controller.abort()
}

/**
 * SSE 스트리밍으로 페이지 키워드/단어 설명(kind='keywords') 또는 요약(kind='summary')을 수신합니다.
 * @param {string} sessionId
 * @param {number} pageNum
 * @param {string} kind - 'keywords' | 'summary'
 * @param {string} targetLang
 * @param {boolean} force - true면 캐시를 무시하고 새로 생성
 * @param {function} onToken
 * @param {function} onDone
 * @param {function} onError
 * @returns {function} abort
 */
export function streamPageInsightAPI(sessionId, pageNum, kind, targetLang, force, onToken, onDone, onError) {
  const controller = new AbortController()
  const query = `?kind=${encodeURIComponent(kind)}&target_lang=${encodeURIComponent(targetLang)}&force=${force ? 'true' : 'false'}`

  fetch(`${API_BASE}/insight/${sessionId}/${pageNum}${query}`, {
    signal: controller.signal,
  })
    .then(async (res) => {
      if (!res.ok) {
        const err = await res.json()
        onError(new Error(err.detail || '생성 실패'))
        return
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { value, done } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop()

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const jsonStr = line.slice(6).trim()
          if (!jsonStr) continue

          try {
            const data = JSON.parse(jsonStr)
            if (data.error) {
              onError(new Error(data.error))
              return
            }
            if (data.content) {
              onToken(data.content, data.cached || false)
            }
            if (data.done) {
              onDone(data.cached || false)
              return
            }
          } catch (e) {
            console.warn('SSE 파싱 오류:', e)
          }
        }
      }
    })
    .catch((err) => {
      if (err.name !== 'AbortError') {
        onError(err)
      }
    })

  return () => controller.abort()
}

/**
 * 백그라운드 번역 잡 상태를 조회합니다.
 */
export async function getJobStatus(sessionId) {
  const res = await fetch(`${API_BASE}/jobs/${sessionId}/status`, { cache: 'no-store' })
  if (!res.ok) return null
  return res.json()
}

/**
 * 특정 페이지의 번역 결과를 조회합니다 (MD 기반).
 */
export async function getPageTranslation(sessionId, pageNum, options) {
  const { targetLang, style, ignoreMath, ignoreTable, ignoreRefs } = options
  const query = `?target_lang=${encodeURIComponent(targetLang)}&style=${style}&ignore_math=${ignoreMath}&ignore_table=${ignoreTable}&ignore_refs=${ignoreRefs}`
  const res = await fetch(`${API_BASE}/jobs/${sessionId}/page/${pageNum}${query}`, { cache: 'no-store' })
  if (!res.ok) return null
  return res.json()
}

/**
 * 로그인 요청을 보냅니다. remember가 true면 훨씬 긴 만료 기간의 세션
 * 쿠키를 발급받아, 다음에 앱을 열 때 자동으로 로그인된 상태로 시작한다.
 */
export async function loginAPI(username, password, remember = false) {
  const res = await fetch(`${API_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password, remember })
  })
  if (!res.ok) {
    try {
      const err = await res.json()
      throw new Error(err.detail || '로그인 실패')
    } catch {
      throw new Error('로그인 실패')
    }
  }
  return res.json()
}

/**
 * 로그아웃 요청을 보냅니다.
 */
export async function logoutAPI() {
  const res = await fetch(`${API_BASE}/auth/logout`, { method: 'POST' })
  if (!res.ok) throw new Error('로그아웃 실패')
  return res.json()
}

/**
 * 로그인 상태를 검증합니다.
 */
export async function checkAuthAPI() {
  const res = await fetch(`${API_BASE}/auth/check`)
  if (!res.ok) return null
  return res.json()
}

/**
 * 아이디 및 비밀번호를 변경합니다.
 */
export async function changeCredentialsAPI(currentPassword, newUsername, newPassword) {
  const res = await fetch(`${API_BASE}/auth/change-credentials`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      current_password: currentPassword,
      new_username: newUsername,
      new_password: newPassword
    })
  })
  if (!res.ok) {
    try {
      const err = await res.json()
      throw new Error(err.detail || '변경 실패')
    } catch {
      throw new Error('변경 실패')
    }
  }
  return res.json()
}

/**
 * 로그인 생략(로그인 화면 없이 바로 사용) 설정을 가져옵니다.
 */
export async function getSkipLoginAPI() {
  const res = await fetch(`${API_BASE}/settings/skip-login`)
  if (!res.ok) throw new Error('로그인 생략 설정 로드 실패')
  return res.json()
}

/**
 * 로그인 생략 설정을 저장합니다.
 */
export async function setSkipLoginAPI(enabled) {
  const res = await fetch(`${API_BASE}/settings/skip-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled })
  })
  if (!res.ok) throw new Error('로그인 생략 설정 저장 실패')
  return res.json()
}

/**
 * 시스템 설정(Ollama 호스트 및 모델)을 가져옵니다.
 */
export async function getSystemSettingsAPI() {
  const res = await fetch(`${API_BASE}/settings/system`)
  if (!res.ok) throw new Error('시스템 설정 로드 실패')
  return res.json()
}

/**
 * 시스템 설정(Ollama 호스트 및 모델)을 변경합니다.
 */
export async function saveSystemSettingsAPI(settings) {
  const res = await fetch(`${API_BASE}/settings/system`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings)
  })
  if (!res.ok) {
    try {
      const err = await res.json()
      throw new Error(err.detail || '저장 실패')
    } catch {
      throw new Error('저장 실패')
    }
  }
  return res.json()
}

/**
 * 번역 잡을 새 옵션으로 재시작합니다.
 */
export async function restartJobAPI(sessionId, options) {
  const res = await fetch(`${API_BASE}/jobs/${sessionId}/restart`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      target_lang: options.targetLang,
      style: options.style,
      ignore_math: options.ignoreMath,
      ignore_table: options.ignoreTable,
      ignore_refs: options.ignoreRefs
    })
  })
  if (!res.ok) {
    try {
      const err = await res.json()
      throw new Error(err.detail || '번역 재시작 실패')
    } catch {
      throw new Error('번역 재시작 실패')
    }
  }
  return res.json()
}

/**
 * 번역 잡을 취소(중단)합니다.
 */
export async function cancelJobAPI(sessionId) {
  const res = await fetch(`${API_BASE}/jobs/${sessionId}/cancel`, {
    method: 'POST'
  })
  if (!res.ok) {
    try {
      const err = await res.json()
      throw new Error(err.detail || '번역 중지 실패')
    } catch {
      throw new Error('번역 중지 실패')
    }
  }
  return res.json()
}

/**
 * 이 서버에 Ollama CLI가 설치되어 있는지, 설정된 호스트가 로컬인지 확인합니다.
 */
export async function getOllamaStatusAPI() {
  const res = await fetch(`${API_BASE}/settings/ollama-status`)
  return res.json()
}

/**
 * CLI 엔진 설치 SSE 스트림을 구독하는 공통 헬퍼.
 */
function _streamInstallCliAPI(endpoint, defaultErrorMessage, onProgress, onDone, onError) {
  const eventSource = new EventSource(`${API_BASE}${endpoint}`)

  eventSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data)
      if (data.status === 'error') {
        onError(new Error(data.message || defaultErrorMessage))
        eventSource.close()
      } else if (data.status === 'success') {
        onDone()
        eventSource.close()
      } else {
        onProgress(data)
      }
    } catch (err) {
      console.warn('Install stream message parse error:', err)
    }
  }

  eventSource.onerror = () => {
    onError(new Error('네트워크 연결 끊김 또는 설치 실패'))
    eventSource.close()
  }

  return () => eventSource.close()
}

/**
 * 이 서버(localhost)에 Ollama를 설치하고 진행 상황을 스트리밍합니다.
 */
export function streamInstallOllamaAPI(onProgress, onDone, onError) {
  return _streamInstallCliAPI('/settings/install-ollama', 'Ollama 설치 실패', onProgress, onDone, onError)
}

/**
 * 이 서버에 Claude Code CLI를 npm으로 설치하고 진행 상황을 스트리밍합니다.
 */
export function streamInstallClaudeCodeAPI(onProgress, onDone, onError) {
  return _streamInstallCliAPI('/settings/install-claude-code', 'Claude Code CLI 설치 실패', onProgress, onDone, onError)
}

/**
 * 이 서버에 Codex CLI를 npm으로 설치하고 진행 상황을 스트리밍합니다.
 */
export function streamInstallCodexAPI(onProgress, onDone, onError) {
  return _streamInstallCliAPI('/settings/install-codex', 'Codex CLI 설치 실패', onProgress, onDone, onError)
}

/**
 * 이 서버에 Antigravity CLI(agy)를 공식 설치 스크립트로 설치하고 진행 상황을 스트리밍합니다.
 */
export function streamInstallAntigravityAPI(onProgress, onDone, onError) {
  return _streamInstallCliAPI('/settings/install-antigravity', 'Antigravity CLI 설치 실패', onProgress, onDone, onError)
}

/**
 * Ollama 서버에 새로운 모델 다운로드를 요청하고 상태를 스트리밍합니다.
 */
export function streamPullModelAPI(modelName, onStatus, onDone, onError) {
  const query = `?model_name=${encodeURIComponent(modelName)}`
  const eventSource = new EventSource(`${API_BASE}/settings/pull-model${query}`)
  
  eventSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data)
      if (data.status === 'error') {
        onError(new Error(data.message || '다운로드 실패'))
        eventSource.close()
      } else if (data.status === 'success') {
        onDone()
        eventSource.close()
      } else {
        onStatus(data)
      }
    } catch (err) {
      console.warn('Pull model message parse error:', err)
    }
  }
  
  eventSource.onerror = (err) => {
    onError(new Error('네트워크 연결 끊김 또는 다운로드 실패'))
    eventSource.close()
  }
  
  return () => eventSource.close()
}

/**
 * Ollama 서버에서 설치된 모델을 삭제합니다.
 */
export async function deleteModelAPI(modelName) {
  const resp = await fetch(`${API_BASE}/settings/delete-model`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model_name: modelName })
  })
  if (!resp.ok) {
    const errorData = await resp.json().catch(() => ({}))
    throw new Error(errorData.detail || 'Ollama 모델 삭제에 실패했습니다.')
  }
  return await resp.json()
}


/**
 * AI 전문가와 채팅을 주고받는 POST 스트리밍 API를 호출합니다.
 * @param {string} sessionId
 * @param {Array} messages - [{role: 'user', content: '...'}, ...]
 * @param {function} onToken - 토큰 수신 시 콜백
 * @param {function} onDone - 완료 시 콜백
 * @param {function} onError - 에러 발생 시 콜백
 * @param {string} [imageBase64] - 캡처 모드로 첨부한 이미지의 raw base64(PNG,
 *   data URL 접두사 없음). 있으면 이번 질문에 실제로 첨부되어 vision을 지원하는
 *   provider가 캡처 영역을 직접 보고 답한다.
 * @returns {function} abort - 중단 함수
 */
export function streamChatAPI(sessionId, messages, onToken, onDone, onError, imageBase64) {
  const controller = new AbortController()

  fetch(`${API_BASE}/chat/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      session_id: sessionId,
      messages: messages,
      image_base64: imageBase64 || undefined
    }),
    signal: controller.signal
  })
    .then(async (res) => {
      if (!res.ok) {
        try {
          const err = await res.json()
          onError(new Error(err.detail || '답변 생성 실패'))
        } catch {
          onError(new Error('답변 생성 실패'))
        }
        return
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()

      while (true) {
        const { value, done } = await reader.read()
        if (done) break

        const token = decoder.decode(value, { stream: true })
        if (token) {
          onToken(token)
        }
      }
      onDone()
    })
    .catch((err) => {
      if (err.name !== 'AbortError') {
        onError(err)
      }
    })

  return () => controller.abort()
}


/**
 * 직전 어시스턴트 답변과 논문 본문을 참고해 후속 질문 3개를 추천받습니다.
 * @param {string} sessionId
 * @param {Array} messages - [{role: 'user'|'assistant', content: '...'}, ...]
 * @returns {Promise<string[]>} 추천 질문 목록 (최대 3개)
 */
export async function getSuggestedQuestionsAPI(sessionId, messages) {
  const res = await fetch(`${API_BASE}/chat/suggestions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: sessionId, messages })
  })
  if (!res.ok) throw new Error('추천 질문 생성 실패')
  const data = await res.json()
  return data.questions || []
}


/**
 * 세션의 번역 캐시를 삭제합니다.
 */
export async function clearTranslationCacheAPI(sessionId) {
  const res = await fetch(`${API_BASE}/translate/${sessionId}/clear-cache`, {
    method: 'POST'
  })
  if (!res.ok) {
    try {
      const err = await res.json()
      throw new Error(err.detail || '캐시 삭제 실패')
    } catch {
      throw new Error('캐시 삭제 실패')
    }
  }
  return res.json()
}

/**
 * 모든 문서의 PDF 텍스트 추출 결과 디스크 캐시를 삭제합니다(서버/앱 재시작
 * 후 첫 열람 속도를 위한 캐시 - 지워도 다음 열람 시 자동으로 다시 채워짐).
 */
export async function clearPagesCacheAPI() {
  const res = await fetch(`${API_BASE}/settings/clear-pages-cache`, {
    method: 'POST'
  })
  if (!res.ok) {
    try {
      const err = await res.json()
      throw new Error(err.detail || '캐시 삭제 실패')
    } catch {
      throw new Error('캐시 삭제 실패')
    }
  }
  return res.json()
}

/**
 * 특정 문서의 PDF 텍스트/이미지 추출 결과 디스크 캐시를 삭제합니다.
 */
export async function clearSingleDocCacheAPI(docId) {
  const res = await fetch(`${API_BASE}/library/${encodeURIComponent(docId)}/clear-cache`, {
    method: 'POST'
  })
  if (!res.ok) {
    try {
      const err = await res.json()
      throw new Error(err.detail || '캐시 삭제 실패')
    } catch {
      throw new Error('캐시 삭제 실패')
    }
  }
  return res.json()
}

/**
 * 특정 문서의 이전 채팅 히스토리를 반환합니다.
 */
export async function getChatHistoryAPI(sessionId) {
  const res = await fetch(`${API_BASE}/chat/${sessionId}/history`, { cache: 'no-store' })
  if (!res.ok) throw new Error('채팅 기록 로드 실패')
  return res.json()
}

/**
 * 여러 논문을 함께 컨텍스트로 제공해 비교/종합 질문에 답하는 스트리밍 API.
 * @param {string[]} docIds - 비교할 문서 ID 목록 (2~5개)
 * @param {Array} messages - [{role: 'user', content: '...'}, ...]
 */
export function streamCompareChatAPI(docIds, messages, onToken, onDone, onError) {
  const controller = new AbortController()

  fetch(`${API_BASE}/chat/compare/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      doc_ids: docIds,
      messages: messages
    }),
    signal: controller.signal
  })
    .then(async (res) => {
      if (!res.ok) {
        try {
          const err = await res.json()
          onError(new Error(err.detail || '답변 생성 실패'))
        } catch {
          onError(new Error('답변 생성 실패'))
        }
        return
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()

      while (true) {
        const { value, done } = await reader.read()
        if (done) break

        const token = decoder.decode(value, { stream: true })
        if (token) {
          onToken(token)
        }
      }
      onDone()
    })
    .catch((err) => {
      if (err.name !== 'AbortError') {
        onError(err)
      }
    })

  return () => controller.abort()
}

/**
 * 문서 ID 조합에 대한 비교 채팅 히스토리를 반환합니다.
 */
export async function getCompareChatHistoryAPI(docIds) {
  const res = await fetch(`${API_BASE}/chat/compare/history?doc_ids=${encodeURIComponent(docIds.join(','))}`, { cache: 'no-store' })
  if (!res.ok) throw new Error('채팅 기록 로드 실패')
  return res.json()
}

/**
 * AI 어시스턴트(단일 논문) 채팅 세션 목록을 반환합니다.
 */
export async function getChatSessionsAPI() {
  const res = await fetch(`${API_BASE}/chat/sessions`, { cache: 'no-store' })
  if (!res.ok) throw new Error('채팅 세션 목록 로드 실패')
  return res.json()
}

/**
 * 논문 비교 채팅 세션 목록을 반환합니다.
 */
export async function getCompareChatSessionsAPI() {
  const res = await fetch(`${API_BASE}/chat/compare-sessions`, { cache: 'no-store' })
  if (!res.ok) throw new Error('비교 채팅 세션 목록 로드 실패')
  return res.json()
}

/**
 * Antigravity CLI 사용량 통계 조회
 */
export async function getAgyUsageAPI() {
  const res = await fetch(`${API_BASE}/agy/usage`, { cache: 'no-store' })
  if (!res.ok) throw new Error('사용량 조회 실패')
  return res.json()
}

/**
 * agy 지원 모델 목록 조회
 */
export async function getAgyModelsAPI() {
  const res = await fetch(`${API_BASE}/agy/models`, { cache: 'no-store' })
  if (!res.ok) throw new Error('모델 목록 조회 실패')
  return res.json()
}

/**
 * 시스템 업데이트 API 요청을 보냅니다.
 */
export async function triggerSystemUpdateAPI() {
  const res = await fetch(`${API_BASE}/settings/update`, {
    method: 'POST'
  })
  if (!res.ok) {
    try {
      const err = await res.json()
      throw new Error(err.detail || '업데이트 실패')
    } catch {
      throw new Error('업데이트 실패')
    }
  }
  return res.json()
}

/**
 * 자동 업데이트 확인 주기 설정을 조회/저장합니다.
 */
export async function getUpdateCheckConfigAPI() {
  const res = await fetch(`${API_BASE}/settings/update-check-config`, { cache: 'no-store' })
  if (!res.ok) throw new Error('업데이트 확인 설정 조회 실패')
  return res.json()
}

export async function setUpdateCheckConfigAPI(interval) {
  const res = await fetch(`${API_BASE}/settings/update-check-config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ interval })
  })
  if (!res.ok) throw new Error('업데이트 확인 설정 저장 실패')
  return res.json()
}

/**
 * 원격 저장소를 확인해 새 버전이 있는지 조회합니다 (변경 로그 포함).
 */
export async function checkForUpdateAPI() {
  const res = await fetch(`${API_BASE}/settings/update-check`, { cache: 'no-store' })
  if (!res.ok) throw new Error('업데이트 확인 실패')
  return res.json()
}

/**
 * 방금 업데이트가 적용되어 재시작된 직후라면(1회 한정) 안내 정보를 조회합니다.
 */
export async function getPostUpdateNoticeAPI() {
  const res = await fetch(`${API_BASE}/settings/post-update-notice`, { cache: 'no-store' })
  if (!res.ok) throw new Error('업데이트 완료 안내 조회 실패')
  return res.json()
}

/**
 * 저장소 루트 CHANGELOG.md 전체 내용을 조회합니다.
 */
export async function getFullChangelogAPI() {
  const res = await fetch(`${API_BASE}/settings/changelog`, { cache: 'no-store' })
  if (!res.ok) throw new Error('변경 이력 조회 실패')
  return res.json()
}

export async function fetchTrashAPI() {
  const res = await fetch(`${API_BASE}/library/trash`, { cache: 'no-store' })
  if (!res.ok) throw new Error('휴지통 목록 조회 실패')
  return res.json()
}

export async function restoreLibraryDocAPI(docId) {
  const res = await fetch(`${API_BASE}/library/${docId}/restore`, { method: 'POST' })
  if (!res.ok) throw new Error('문서 복원 실패')
  return res.json()
}

export async function emptyTrashAPI() {
  const res = await fetch(`${API_BASE}/library/trash/empty`, { method: 'DELETE' })
  if (!res.ok) throw new Error('휴지통 비우기 실패')
  return res.json()
}

/**
 * PDF 파서 엔진 목록 및 상태 정보를 조회합니다.
 */
export async function fetchPdfParsersInfoAPI() {
  const res = await fetch(`${API_BASE}/settings/pdf-parsers`, { cache: 'no-store' })
  if (!res.ok) throw new Error('PDF 파서 정보 조회 실패')
  return res.json()
}

/**
 * 특정 PDF 파서 패키지를 가상환경에 동적으로 설치하는 SSE 스트리밍 API를 호출합니다.
 */
export function installPdfParserAPI(parserId, onProgress, onSuccess, onError) {
  const es = new EventSource(`${API_BASE}/settings/install-pdf-parser?parser_id=${encodeURIComponent(parserId)}`)

  es.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data)
      if (data.status === 'progress') {
        if (onProgress) onProgress(data.line)
      } else if (data.status === 'success') {
        es.close()
        if (onSuccess) onSuccess(data.message)
      } else if (data.status === 'error') {
        es.close()
        if (onError) onError(new Error(data.message || '설치 중 오류가 발생했습니다.'))
      }
    } catch (err) {
      es.close()
      if (onError) onError(err)
    }
  }

  es.onerror = (err) => {
    es.close()
    if (onError) onError(new Error('네트워크 연결 끊김 또는 서버 오류가 발생했습니다.'))
  }

  return es
}

export async function uninstallPdfParserAPI(parserId) {
  const res = await fetch(`${API_BASE}/settings/uninstall-pdf-parser`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ parser_id: parserId })
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.detail || `삭제 요청 실패 (${res.status})`)
  }
  return res.json()
}



