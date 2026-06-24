const API_BASE = '/api'

export async function uploadPDF(file, options, onProgress) {
  const formData = new FormData()
  formData.append('file', file)

  const { targetLang, style, ignoreMath, ignoreTable, ignoreRefs } = options
  const query = `?target_lang=${encodeURIComponent(targetLang)}&style=${style}&ignore_math=${ignoreMath}&ignore_table=${ignoreTable}&ignore_refs=${ignoreRefs}`

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
 * @param {function} onToken - 토큰이 수신될 때마다 호출
 * @param {function} onDone - 완료 시 호출
 * @param {function} onError - 오류 시 호출
 * @returns {function} abort - 번역 중단 함수
 */
export function streamTranslation(sessionId, pageNum, onToken, onDone, onError) {
  const controller = new AbortController()

  fetch(`${API_BASE}/translate/${sessionId}/${pageNum}`, {
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
 * 로그인 요청을 보냅니다.
 */
export async function loginAPI(username, password) {
  const res = await fetch(`${API_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
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
 * AI 전문가와 채팅을 주고받는 POST 스트리밍 API를 호출합니다.
 * @param {string} sessionId
 * @param {Array} messages - [{role: 'user', content: '...'}, ...]
 * @param {function} onToken - 토큰 수신 시 콜백
 * @param {function} onDone - 완료 시 콜백
 * @param {function} onError - 에러 발생 시 콜백
 * @returns {function} abort - 중단 함수
 */
export function streamChatAPI(sessionId, messages, onToken, onDone, onError) {
  const controller = new AbortController()

  fetch(`${API_BASE}/chat/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      session_id: sessionId,
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
 * 특정 문서의 이전 채팅 히스토리를 반환합니다.
 */
export async function getChatHistoryAPI(sessionId) {
  const res = await fetch(`${API_BASE}/chat/${sessionId}/history`, { cache: 'no-store' })
  if (!res.ok) throw new Error('채팅 기록 로드 실패')
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







