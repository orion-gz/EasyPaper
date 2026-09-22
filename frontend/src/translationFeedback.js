import { errorMessage } from './i18n.js'

export function translationFeedback(payload, fallback = '') {
  const detail = payload?.detail || payload
  const message = errorMessage(detail, fallback)
  return detail?.code ? `${message} [${detail.code}]` : message
}

export function translationError(payload, fallback = '') {
  const error = new Error(translationFeedback(payload, fallback))
  error.code = (payload?.detail || payload)?.code
  return error
}
