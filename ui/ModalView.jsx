import { useCallback, useEffect, useId, useRef, useState } from 'react'

export function ModalView({ state }) {
  const [value, setValue] = useState(state.kind === 'prompt' ? (state.defaultValue || '') : '')
  const inputRef = useRef(null)
  // The dialog box itself. role/aria-modal/aria-labelledby live here so AT
  // announces it as a modal dialog, and it scopes the Tab focus-trap below.
  const dialogRef = useRef(null)
  // The element focused before the modal opened, captured once at mount so
  // closing the modal returns focus exactly where it was (keyboard/AT users
  // don't get dumped at the top of the document).
  const openerRef = useRef(null)
  const titleId = useId()

  // Cancel resolves the modal the same way clicking Cancel / the scrim does:
  // alert has no "no" answer, confirm answers false, prompt answers null.
  const cancel = useCallback(() => {
    if (state.kind === 'alert') state.resolve()
    else state.resolve(state.kind === 'prompt' ? null : false)
  }, [state])

  useEffect(() => {
    openerRef.current = document.activeElement
    if (state.kind === 'prompt' && inputRef.current) {
      // Autofocus + select-all so the user can replace any prefilled
      // value with a single keypress.
      inputRef.current.focus()
      inputRef.current.select()
    } else {
      // No input to land on: focus the dialog box so the first Tab stays
      // trapped inside and AT reads the dialog from its labelled title.
      dialogRef.current?.focus()
    }
    const onKey = (e) => {
      if (e.key === 'Escape') {
        cancel()
        return
      }
      if (e.key !== 'Tab') return
      // Trap Tab within the dialog. The focusable set is recomputed per
      // keydown rather than cached because the prompt input and the action
      // buttons that make it up vary by modal kind.
      const focusable = dialogRef.current?.querySelectorAll(
        'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      )
      if (!focusable || focusable.length === 0) {
        e.preventDefault()
        return
      }
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      const active = document.activeElement
      if (e.shiftKey && active === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && active === last) {
        e.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      const opener = openerRef.current
      if (opener && typeof opener.focus === 'function' && document.contains(opener)) {
        opener.focus()
      }
    }
  }, [state, cancel])
  function onSubmit(e) {
    e.preventDefault()
    if (state.kind === 'prompt') state.resolve(value)
    else if (state.kind === 'confirm') state.resolve(true)
    else state.resolve()
  }
  return (
    <div className="modal-scrim" onClick={() => {
      // Click outside cancels (except for alert, which only has OK).
      cancel()
    }}>
      <div
        className="modal"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <form onSubmit={onSubmit}>
          <div className="modal-title" id={titleId}>{state.title}</div>
          <div className="modal-body">{state.body}</div>
          {state.kind === 'prompt' && (
            <input
              ref={inputRef}
              className="modal-input"
              type="text"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={state.placeholder}
            />
          )}
          <div className="modal-actions">
            {(state.kind === 'confirm' || state.kind === 'prompt') && (
              <button
                type="button"
                className="modal-btn modal-btn--secondary"
                onClick={cancel}
              >
                Cancel
              </button>
            )}
            <button
              type="submit"
              className={`modal-btn ${state.danger ? 'modal-btn--danger' : 'modal-btn--primary'}`}
            >
              {state.kind === 'confirm' ? (state.danger ? 'Delete' : 'OK')
                : state.kind === 'prompt' ? 'OK'
                : 'OK'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
