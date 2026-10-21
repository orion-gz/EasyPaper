import { t } from './i18n.js'
import { fetchLibraryDoc, updateLibraryDocMetadata } from './library.js'
import { formatDocumentCitation } from './commandArguments.js'

export function createReaderCommandActions(adapter) {
  const { state, toast } = adapter
  const $ = id => document.getElementById(id)
  return async (name, { argument = '', page, context }) => {
    if (name === 'bookmark') {
      const doc = await fetchLibraryDoc(state.sessionId)
      const previous = Array.isArray(doc.metadata?.bookmarks) ? doc.metadata.bookmarks : []
      const removed = previous.includes(page)
      const bookmarks = removed ? previous.filter(value => value !== page) : [...previous, page].sort((a, b) => a - b)
      await updateLibraryDocMetadata(state.sessionId, { bookmarks })
      state.currentDocMetadata.bookmarks = bookmarks
      toast(removed ? t('viewer:commands.bookmarkRemoved', { page }) : t('viewer:commands.bookmarkAdded', { page }), 'success')
      return
    }
    if (name === 'copy-citation') {
      const text = formatDocumentCitation({ id: state.sessionId, filename: state.filename, metadata: state.currentDocMetadata })
      await window.parent.navigator.clipboard.writeText(text)
      toast(t('viewer:commands.citationCopied'), 'success')
      return
    }
    if (name === 'memo') {
      if (state.currentContentKind === 'html_article') {
        const content = await adapter.promptMemo()
        if (content && !state.articleViewer.addPageMemo(page, content)) throw new Error(t('viewer:commands.pageLoading'))
        return
      }
      const wrapper = document.querySelector(`.pdf-page-wrapper[data-page="${page}"]`)
      if (!wrapper) throw new Error(t('viewer:commands.pageLoading'))
      const memos = adapter.loadMemos(state.sessionId)
      const key = `page_${page}`
      const memo = { id: `memo_${crypto.randomUUID()}`, pageNum: page, sentenceIdx: -1, sentenceText: '', content: '', createdAt: new Date().toISOString(), x: 45, y: 15 }
      ;(memos[key] ||= []).push(memo)
      adapter.saveMemos(state.sessionId, memos)
      adapter.revealMemos()
      adapter.renderPageMemos(page)
      const card = wrapper.querySelector(`[data-id="${memo.id}"]`)
      if (!card) throw new Error(t('viewer:commands.pageLoading'))
      card.scrollIntoView({ block: 'nearest' })
      card.querySelector('.edit-btn')?.click()
      return
    }
    if (['ask', 'new-chat', 'summarize'].includes(name)) {
      if (context?.documentId !== state.sessionId) context = null
      if (state.chatActiveStream) throw new Error(t('viewer:commands.chatBusy'))
      const input = $('chat-input')
      if ((name !== 'ask' || argument) && input.value.trim() && !await adapter.confirm(t('viewer:commands.replaceDraft'))) return
      if (name === 'new-chat') {
        state.chatHistory = []
        state.chatCurrentText = ''
        adapter.resetChat()
        $('chat-quote-close-btn')?.click()
        state.quotedText = null; state.quotedImage = null; state.quotedImagePage = null
        $('chat-quote-area').classList.add('hidden')
        input.focus(); return
      }
      if (name === 'ask') {
        if (argument) input.value = argument
        input.dispatchEvent(new Event('input', { bubbles: true }))
        input.focus(); return
      }
      if (context?.text) adapter.ask(context.text, { sourcePage: context.page })
      else {
        state.quotedText = null; state.quotedImage = null; state.quotedImagePage = null
        $('chat-quote-area').classList.add('hidden')
      }
      input.value = context?.text ? t('viewer:commands.summarySelectionPrompt') : t('viewer:commands.summaryDocumentPrompt')
      return adapter.sendChat()
    }
  }
}
