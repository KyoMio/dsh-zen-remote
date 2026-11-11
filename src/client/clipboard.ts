/**
 * Browser clipboard helper with plain-HTTP (non-secure context) fallback.
 *
 * `navigator.clipboard` is `undefined` on `http://<lan-ip>:<port>` in modern
 * browsers; falling back to an offscreen read-only `<textarea>` +
 * `document.execCommand('copy')` keeps copy buttons working without throwing.
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  if (!text) return false

  if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      // Fall through to execCommand('copy') fallback.
    }
  }

  if (typeof document === 'undefined' || !document.body || typeof document.execCommand !== 'function') {
    return false
  }

  let textarea: HTMLTextAreaElement | null = null
  const previousActive = document.activeElement instanceof HTMLElement ? document.activeElement : null
  try {
    textarea = document.createElement('textarea')
    textarea.value = text
    textarea.setAttribute('readonly', '')
    textarea.setAttribute('aria-hidden', 'true')
    textarea.style.position = 'fixed'
    textarea.style.top = '-9999px'
    textarea.style.left = '-9999px'
    textarea.style.opacity = '0'
    textarea.style.pointerEvents = 'none'
    document.body.appendChild(textarea)
    textarea.focus({ preventScroll: true })
    textarea.select()
    textarea.setSelectionRange(0, text.length)
    return Boolean(document.execCommand('copy'))
  } catch {
    return false
  } finally {
    if (textarea !== null && textarea.parentNode) {
      textarea.parentNode.removeChild(textarea)
    }
    try {
      previousActive?.focus({ preventScroll: true })
    } catch {
      // Ignore focus restoration error.
    }
  }
}
