// 첫 실행 시 AI 엔진 자동 감지 / 설치 안내 온보딩 모달
// main.js에서 분리됨 - DOM 참조 및 로직은 이 파일 안에서만 쓰인다.
import {
  getSystemSettingsAPI, fetchCliAvailability, getOllamaStatusAPI, saveSystemSettingsAPI,
  streamInstallOllamaAPI, streamInstallClaudeCodeAPI, streamInstallCodexAPI, streamInstallAntigravityAPI,
  streamPullModelAPI,
} from './api.js'
export function createOnboarding({
  openOverlayModal, closeOverlayModal, showToast, escapeHtml, providerConfig,
  viewerTransPicker, settingDefaultAiPicker, settingTransPicker,
  chatSidebarPicker, settingChatPicker, settingAnalysisPicker, settingLibraryPicker,
}) {
  const $ = (id) => document.getElementById(id)

  const onboardingModal        = $('onboarding-modal')
  const onboardingCloseBtn     = $('onboarding-close-btn')
  const onboardingSkipBtn      = $('onboarding-skip-btn')
  const onboardingDetecting    = $('onboarding-detecting')
  const onboardingDetected     = $('onboarding-detected')
  const onboardingDetectedList = $('onboarding-detected-list')
  const onboardingNextBtn      = $('onboarding-next-btn')
  const onboardingModelSelect  = $('onboarding-model-select')
  const onboardingBackBtn      = $('onboarding-back-btn')
  const onboardingModelSelectProvider = $('onboarding-model-select-provider')
  const onboardingModelList    = $('onboarding-model-list')
  const onboardingModelPullSection    = $('onboarding-model-pull-section')
  const onboardingConfirmBtn   = $('onboarding-confirm-btn')
  const onboardingInstall      = $('onboarding-install')
  const onboardingInstallIntro = $('onboarding-install-intro')
  const onboardingInstallOllamaBtn     = $('onboarding-install-ollama-btn')
  const onboardingInstallClaudeCodeBtn = $('onboarding-install-claude-code-btn')
  const onboardingInstallCodexBtn      = $('onboarding-install-codex-btn')
  const onboardingInstallAntigravityBtn = $('onboarding-install-antigravity-btn')
  const onboardingInstallProgressArea  = $('onboarding-install-progress-area')
  const onboardingInstallStatus        = $('onboarding-install-status')
  const onboardingInstallLog           = $('onboarding-install-log')
  const onboardingPullProgressArea     = $('onboarding-pull-progress-area')
  const onboardingPullStatusText       = $('onboarding-pull-status-text')
  const onboardingPullPctText          = $('onboarding-pull-pct-text')
  const onboardingPullProgressBar      = $('onboarding-pull-progress-bar')

  const ONBOARDING_SEEN_KEY = 'easypaper_onboarding_seen'

  function maybeShowOnboarding() {
    if (!onboardingModal) return
    if (localStorage.getItem(ONBOARDING_SEEN_KEY) === '1') return
    openOnboarding()
  }

  // 감지 결과와 마법사 진행 상태(감지됨 선택 → 모델 선택 → 확인)를 함께 보관
  const onboardingState = {
    sys: null, cli: null, ollamaStatus: null,
    detected: [], selectedDetectedIdx: null,
    currentEntry: null, selectedModel: null,
    step: 'detecting',
  }

  // 온보딩 4단계(감지 중 / 감지됨 선택 / 모델 선택 / 설치 안내) 중 하나로 전환.
  // 감지됨·설치 섹션은 "모델 선택" 단계에서는 별도 화면처럼 숨겨 선택에 집중하게 함
  function showOnboardingStep(step) {
    onboardingState.step = step
    onboardingDetecting.classList.toggle('hidden', step !== 'detecting')
    onboardingDetected.classList.toggle('hidden', !(step === 'detected' && onboardingState.detected.length > 0))
    if (onboardingModelSelect) onboardingModelSelect.classList.toggle('hidden', step !== 'model-select')
    onboardingInstall.classList.toggle('hidden', step === 'detecting' || step === 'model-select')
  }

  function openOnboarding() {
    openOverlayModal(onboardingModal)
    showOnboardingStep('detecting')
    detectAndRenderOnboarding()
  }

  function closeOnboarding() {
    closeOverlayModal(onboardingModal)
    localStorage.setItem(ONBOARDING_SEEN_KEY, '1')
  }

  if (onboardingCloseBtn) onboardingCloseBtn.addEventListener('click', closeOnboarding)
  if (onboardingSkipBtn) onboardingSkipBtn.addEventListener('click', closeOnboarding)
  if (onboardingModal) {
    onboardingModal.addEventListener('click', (e) => {
      if (e.target === onboardingModal) closeOnboarding()
    })
  }

  // 설치 버튼 하나를 "설치 가능" 또는 "✓ 설치됨" 상태로 표시.
  // 방금 설치 액션이 성공해 이미 "설치됨" 표시 중인 버튼은, 재감지 결과가 아직 그 사실을
  // 못 따라잡았더라도(예: Ollama 모델 감지 전) 되돌리지 않는다.
  function setOnboardingRowInstalledState(btn, isInstalled) {
    if (!btn) return
    if (isInstalled) {
      btn.disabled = true
      btn.textContent = '✓ 설치됨'
      btn.classList.add('onboarding-install-done')
    } else if (!btn.classList.contains('onboarding-install-done')) {
      btn.disabled = false
      btn.textContent = '설치'
    }
  }

  async function detectAndRenderOnboarding() {
    let sys, cli, ollamaStatus
    try {
      [sys, cli, ollamaStatus] = await Promise.all([
        getSystemSettingsAPI(),
        fetchCliAvailability().catch(() => ({ antigravity: false, claude_code: false, codex: false })),
        getOllamaStatusAPI().catch(() => ({ installed: false })),
      ])
    } catch (err) {
      console.warn('온보딩 감지 실패:', err)
      closeOnboarding()
      return
    }

    onboardingState.sys = sys
    onboardingState.cli = cli
    onboardingState.ollamaStatus = ollamaStatus

    const detected = []
    // Ollama는 바이너리만 설치되어 있어도(아직 모델이 없어도) 감지 목록에 넣어,
    // "다음" 버튼으로 이어지는 모델 선택 단계에서 바로 모델을 받게 함
    if (ollamaStatus.installed) {
      const models = sys.available_models || []
      detected.push({
        provider: 'ollama',
        label: 'Ollama (로컬)',
        sub: models.length > 0 ? `${models[0]}${models.length > 1 ? ` 외 ${models.length - 1}개` : ''}` : '설치됨 · 모델 다운로드 필요',
      })
    }
    if (cli.claude_code) {
      detected.push({ provider: 'claude_code', label: 'Claude Code', sub: 'CLI 감지됨' })
    }
    if (cli.codex) {
      detected.push({ provider: 'codex', label: 'Codex', sub: 'CLI 감지됨' })
    }
    if (cli.antigravity) {
      detected.push({ provider: 'antigravity', label: 'Antigravity', sub: 'CLI 감지됨' })
    }
    if (sys.openai_api_key) {
      detected.push({ provider: 'openai', label: 'OpenAI', sub: 'API 키 설정됨' })
    }
    if (sys.gemini_api_key) {
      detected.push({ provider: 'gemini', label: 'Gemini', sub: 'API 키 설정됨' })
    }
    if (sys.claude_api_key) {
      detected.push({ provider: 'claude', label: 'Anthropic Claude', sub: 'API 키 설정됨' })
    }
    onboardingState.detected = detected
    onboardingState.selectedDetectedIdx = null
    if (onboardingNextBtn) onboardingNextBtn.disabled = true

    // 1. 감지된 엔진은 바로 저장하지 않고, 선택 → "다음"으로 모델 선택 단계로 이동
    if (detected.length > 0) {
      onboardingDetectedList.innerHTML = detected.map((d, i) => `
        <button type="button" class="onboarding-detected-btn" data-idx="${i}">
          <span>${escapeHtml(d.label)}</span>
          <span class="onboarding-detected-sub">${escapeHtml(d.sub)}</span>
        </button>
      `).join('')
      onboardingDetectedList.querySelectorAll('.onboarding-detected-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          onboardingDetectedList.querySelectorAll('.onboarding-detected-btn').forEach(b => b.classList.remove('selected'))
          btn.classList.add('selected')
          onboardingState.selectedDetectedIdx = Number(btn.dataset.idx)
          if (onboardingNextBtn) onboardingNextBtn.disabled = false
        })
      })
    }

    // 2. 설치 목록에서는 이미 감지된 엔진의 행을 제거 - Ollama가 감지됐어도
    //    Claude Code 등 다른 CLI는 여전히 추가로 설치할 수 있어야 함
    if (onboardingInstallIntro) {
      onboardingInstallIntro.textContent = detected.length > 0
        ? '추가로 설치할 수 있는 AI 엔진입니다.'
        : '사용 가능한 AI 엔진이 감지되지 않았습니다. 아래에서 하나를 설치해주세요.'
    }
    const detectedProviders = new Set(detected.map(d => d.provider))
    onboardingInstall.querySelectorAll('.onboarding-install-row').forEach((row) => {
      row.classList.toggle('hidden', detectedProviders.has(row.dataset.provider))
    })
    setOnboardingRowInstalledState(onboardingInstallOllamaBtn, !!ollamaStatus.installed)
    setOnboardingRowInstalledState(onboardingInstallClaudeCodeBtn, !!cli.claude_code)
    setOnboardingRowInstalledState(onboardingInstallCodexBtn, !!cli.codex)
    setOnboardingRowInstalledState(onboardingInstallAntigravityBtn, !!cli.antigravity)

    showOnboardingStep('detected')
  }

  // 새로 선택 가능해진 엔진 목록으로 시선을 유도 (스크롤 + 잠깐 테두리 강조)
  function highlightOnboardingDetected() {
    if (!onboardingDetected || onboardingDetected.classList.contains('hidden')) return
    onboardingDetected.scrollIntoView({ behavior: 'smooth', block: 'start' })
    onboardingDetected.classList.add('onboarding-attention-pulse')
    setTimeout(() => onboardingDetected.classList.remove('onboarding-attention-pulse'), 1600)
  }

  // "다음" 팝업: 선택한 프로바이더에서 사용할 모델을 고르는 단계.
  // Ollama는 이미 받아둔 모델 목록 + 새 모델 다운로드 섹션을, 나머지 CLI/API 프로바이더는
  // providerConfig에 정의된 모델 목록을 보여준다.
  function renderModelSelectStep(entry) {
    onboardingState.currentEntry = entry
    onboardingState.selectedModel = null
    if (onboardingConfirmBtn) onboardingConfirmBtn.disabled = true
    if (onboardingModelSelectProvider) onboardingModelSelectProvider.textContent = entry.label

    let models = []
    if (entry.provider === 'ollama') {
      models = (onboardingState.sys?.available_models || []).map(m => ({ value: m, label: m }))
    } else {
      const cfg = providerConfig.find(p => p.id === entry.provider)
      models = cfg ? cfg.models : []
    }

    if (onboardingModelList) {
      if (models.length === 0) {
        onboardingModelList.innerHTML = `<div style="font-size: 12.5px; color: var(--text-secondary); padding: 10px 2px; line-height: 1.6;">아직 다운로드된 모델이 없습니다. 아래에서 모델을 다운로드해주세요.</div>`
      } else {
        let lastGroup = null
        onboardingModelList.innerHTML = models.map((m, i) => {
          let groupHtml = ''
          if (m.group && m.group !== lastGroup) {
            lastGroup = m.group
            groupHtml = `<div style="font-size: 11px; font-weight: 700; color: var(--text-tertiary); margin: ${i === 0 ? '0' : '10px'} 0 2px 2px;">${escapeHtml(m.group)}</div>`
          }
          return `${groupHtml}<button type="button" class="onboarding-detected-btn onboarding-model-btn" data-value="${escapeHtml(m.value)}"><span>${escapeHtml(m.label)}</span></button>`
        }).join('')
      }
      onboardingModelList.querySelectorAll('.onboarding-model-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          onboardingModelList.querySelectorAll('.onboarding-model-btn').forEach(b => b.classList.remove('selected'))
          btn.classList.add('selected')
          onboardingState.selectedModel = btn.dataset.value
          if (onboardingConfirmBtn) onboardingConfirmBtn.disabled = false
        })
      })
      const firstBtn = onboardingModelList.querySelector('.onboarding-model-btn')
      if (firstBtn) firstBtn.click()
    }

    if (onboardingModelPullSection) {
      onboardingModelPullSection.classList.toggle('hidden', entry.provider !== 'ollama')
    }
  }

  if (onboardingNextBtn) {
    onboardingNextBtn.addEventListener('click', () => {
      if (onboardingState.selectedDetectedIdx === null) return
      const entry = onboardingState.detected[onboardingState.selectedDetectedIdx]
      if (!entry) return
      renderModelSelectStep(entry)
      showOnboardingStep('model-select')
    })
  }

  if (onboardingBackBtn) {
    onboardingBackBtn.addEventListener('click', () => {
      showOnboardingStep('detected')
    })
  }

  if (onboardingConfirmBtn) {
    onboardingConfirmBtn.addEventListener('click', async () => {
      const entry = onboardingState.currentEntry
      const model = onboardingState.selectedModel
      if (!entry || !model) return
      const sys = onboardingState.sys
      onboardingConfirmBtn.disabled = true
      try {
        await saveSystemSettingsAPI({
          ollama_host: sys.ollama_host,
          default_ai_provider: entry.provider,
          default_ai_model: model,
          trans_provider: entry.provider,
          trans_model: model,
          chat_provider: entry.provider,
          chat_model: model,
          analysis_provider: entry.provider,
          analysis_model: model,
          library_provider: entry.provider,
          library_model: model,
          openai_api_key: sys.openai_api_key,
          gemini_api_key: sys.gemini_api_key,
          claude_api_key: sys.claude_api_key,
          translation_prompt_template: sys.translation_prompt_template,
        })
        // sync compact pickers so the viewer/chat UI reflects the newly selected engine immediately
        viewerTransPicker.setValue(entry.provider, model)
        settingDefaultAiPicker.setValue(entry.provider, model)
        settingTransPicker.setValue(entry.provider, model)
        chatSidebarPicker.setValue(entry.provider, model)
        settingChatPicker.setValue(entry.provider, model)
        settingAnalysisPicker.setValue(entry.provider, model)
        settingLibraryPicker.setValue(entry.provider, model)
        showToast(`${entry.label}을(를) 기본 AI 엔진으로 설정했습니다.`, 'success')
        closeOnboarding()
      } catch (err) {
        showToast(err.message || '설정 저장 실패', 'error')
        onboardingConfirmBtn.disabled = false
      }
    })
  }

  function wireOnboardingInstallBtn(btn, streamFn, label) {
    if (!btn) return
    const originalText = btn.textContent
    btn.addEventListener('click', () => {
      btn.disabled = true
      btn.textContent = '설치 중...'
      btn.classList.remove('onboarding-install-done')
      onboardingInstallProgressArea.classList.remove('hidden')
      onboardingInstallStatus.textContent = `${label} 설치 진행 중...`
      onboardingInstallLog.textContent = ''

      streamFn(
        (data) => {
          if (data.line) {
            onboardingInstallLog.textContent += data.line + '\n'
            onboardingInstallLog.scrollTop = onboardingInstallLog.scrollHeight
          }
        },
        async () => {
          // 버튼에 "설치됨" 상태를 영구적으로 남겨 완료 여부를 눈으로 바로 확인할 수 있게 함
          // (예전에는 원래 텍스트로 바로 되돌려버려서 설치가 끝나도 아무 표시가 남지 않았음)
          btn.textContent = '✓ 설치됨'
          btn.classList.add('onboarding-install-done')
          onboardingInstallStatus.textContent = label === 'Ollama'
            ? 'Ollama 설치 완료! 위 목록에서 Ollama를 선택하고 "다음"을 눌러 모델을 다운로드해주세요.'
            : `${label} 설치 완료! 터미널에서 로그인을 마치면 위에서 바로 선택할 수 있습니다.`
          showToast(`${label} 설치가 완료되었습니다! 다음 단계를 확인해주세요.`, 'success')
          // 방금 완료된 상태를 잠깐 보여준 뒤, 새로 감지된 엔진 선택 화면으로 시선을 유도
          await new Promise(resolve => setTimeout(resolve, 900))
          await detectAndRenderOnboarding()
          highlightOnboardingDetected()
        },
        (err) => {
          showToast(`${label} 설치 실패: ${err.message}`, 'error')
          onboardingInstallStatus.textContent = err.message
          btn.disabled = false
          btn.textContent = originalText
        }
      )
    })
  }

  wireOnboardingInstallBtn(onboardingInstallOllamaBtn, streamInstallOllamaAPI, 'Ollama')
  wireOnboardingInstallBtn(onboardingInstallClaudeCodeBtn, streamInstallClaudeCodeAPI, 'Claude Code CLI')
  wireOnboardingInstallBtn(onboardingInstallCodexBtn, streamInstallCodexAPI, 'Codex CLI')
  wireOnboardingInstallBtn(onboardingInstallAntigravityBtn, streamInstallAntigravityAPI, 'Antigravity CLI')

  // Ollama "다음 단계" 추천 모델 원클릭 다운로드
  document.querySelectorAll('.onboarding-pull-model-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const modelName = btn.dataset.model
      document.querySelectorAll('.onboarding-pull-model-btn').forEach(b => { b.disabled = true })
      onboardingPullProgressArea.classList.remove('hidden')
      onboardingPullStatusText.textContent = '다운로드 준비 중...'
      onboardingPullPctText.textContent = '0%'
      onboardingPullProgressBar.style.width = '0%'
      showToast(`${modelName} 모델 다운로드를 시작합니다. 시간이 걸릴 수 있습니다.`, 'info')

      streamPullModelAPI(
        modelName,
        (data) => {
          if (data.status) onboardingPullStatusText.textContent = data.status
          if (data.total && data.completed) {
            const pct = Math.round((data.completed / data.total) * 100) || 0
            onboardingPullProgressBar.style.width = `${pct}%`
            onboardingPullPctText.textContent = `${pct}%`
          }
        },
        async () => {
          showToast(`${modelName} 모델 다운로드가 완료되었습니다!`, 'success')
          document.querySelectorAll('.onboarding-pull-model-btn').forEach(b => { b.disabled = false })
          onboardingPullProgressArea.classList.add('hidden')
          const wasModelSelect = onboardingState.step === 'model-select'
          await detectAndRenderOnboarding()
          // 모델 선택 화면에서 다운로드한 경우, 감지됨 목록으로 돌아가지 않고
          // 그 자리에서 방금 받은 모델이 바로 보이도록 모델 선택 화면을 유지/갱신
          if (wasModelSelect) {
            const entry = onboardingState.detected.find(d => d.provider === 'ollama')
            if (entry) {
              renderModelSelectStep(entry)
              showOnboardingStep('model-select')
            }
          } else {
            highlightOnboardingDetected()
          }
        },
        (err) => {
          showToast(`${modelName} 모델 다운로드 실패: ${err.message}`, 'error')
          document.querySelectorAll('.onboarding-pull-model-btn').forEach(b => { b.disabled = false })
          onboardingPullStatusText.textContent = err.message
        }
      )
    })
  })

  return { maybeShowOnboarding }
}
