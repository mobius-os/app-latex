import { useEffect, useMemo, useRef, useState } from 'react'
import { DEFAULT_PROJECT_ID } from '../constants.js'
import { projectPrefix } from '../domain.js'

function signal(name, payload = {}) {
  try { window.mobius?.signal?.(name, payload) } catch {}
}

// ----------------------------------------------------------------------
// Embedded shell chat. The runtime mounts the real ChatView into an
// iframe, so this app does not duplicate SSE handling, composer state,
// attachments, provider controls, queueing, or polling.
//
// In Read/Edit modes the chat rides inside a window.mobius.split() container
// (pill ↔ split ↔ full) when that API is available. When absent (older shell)
// we fall back to the bespoke chatHeight bottom-panel — identical behavior to
// the previous version. The split path and the fallback path are clearly
// fenced so they never touch each other's layout state.
// ----------------------------------------------------------------------
export function bootstrapPrompt() {
  return [
    "You help the user write and compile their LaTeX documents in this app.",
    "Use the embedded-app-agent skill, which carries the full methodology;",
    "rely on the injected app_context for this app's id, file paths, and",
    "build commands.",
    "",
    "This is a silent setup brief — do NOT reply to it. Wait for the",
    "user's first message and act on that.",
  ].join('\n')
}


// ---------------------------------------------------------------------------
// ChatPanel — the bottom half of the 50/50 chat split. Fills the height the
// body allots it (via --chat-ratio) as a flex column; the embedded chat
// iframe fills the column, so its composer is pinned to the panel's bottom.
// ---------------------------------------------------------------------------
export function ChatPanel({
  appId, token, storage,
  onFilesMaybeChanged,
  guidance,
  getContext,
  activeProjectId,
}) {
  const mountRef = useRef(null)
  const [error, setError] = useState(null)
  // Keep the latest onFilesMaybeChanged in a ref so the mount effect below
  // does NOT depend on it. That callback's identity changes on every file
  // selection (it closes over selectedPath); if it were a mount-effect dep,
  // selecting a file would tear down + remount the chat iframe — destroying a
  // streaming turn mid-flight. The turn-done handler reads the ref instead.
  const onFilesRef = useRef(onFilesMaybeChanged)
  useEffect(() => { onFilesRef.current = onFilesMaybeChanged }, [onFilesMaybeChanged])
  const guidanceRef = useRef(guidance)
  const chatHandleRef = useRef(null)
  useEffect(() => {
    guidanceRef.current = guidance
    chatHandleRef.current?.setGuidance?.(guidance)
  }, [guidance])
  const getContextRef = useRef(getContext)
  useEffect(() => { getContextRef.current = getContext }, [getContext])
  const systemPrompt = useMemo(() => bootstrapPrompt(), [])

  // The helper owns the whole app-chat lifecycle: it creates the chat once
  // (POST /api/app-chats), persists its id as { id } under chat_id.json,
  // reuses it on later mounts, re-applies the system prompt on resume, and
  // reconciles the canonical id on 'ready'. We just give it a mount, the
  // persist key, and the prompt — and destroy the handle on cleanup.
  useEffect(() => {
    const mount = mountRef.current
    if (!mount || !window.mobius || typeof window.mobius.chat !== 'function') {
      setError('Embedded chat is not available in this shell.')
      return undefined
    }
    let disposed = false
    let handle = null
    setError(null)

    window.mobius.chat({
      mount,
      projectId: activeProjectId === DEFAULT_PROJECT_ID ? undefined : activeProjectId,
      persist: `${projectPrefix(activeProjectId)}chat_id.json`,
      title: 'LaTeX',
      systemPrompt,
      picker: true,
      guidance: guidanceRef.current,
      getContext: () => {
        const fn = getContextRef.current
        return fn ? fn() : null
      },
      onTurnDone: () => { if (onFilesRef.current) onFilesRef.current() },
      onError: ({ error: e }) => {
        const message = typeof e === 'string' ? e : 'Embedded chat reported an error.'
        signal('error', { message, source: 'chat' })
        setError(message)
      },
    }).then((nextHandle) => {
      if (disposed) {
        nextHandle.destroy()
        return
      }
      handle = nextHandle
      chatHandleRef.current = nextHandle
      nextHandle.setGuidance?.(guidanceRef.current)
      signal('chat_opened', {})
    }).catch((e) => {
      const message = e.message || 'Could not mount embedded chat.'
      signal('error', { message, source: 'chat-mount' })
      if (!disposed) setError(message)
    })

    return () => {
      disposed = true
      if (chatHandleRef.current === handle) chatHandleRef.current = null
      if (handle) handle.destroy()
    }
  }, [activeProjectId, storage, systemPrompt])

  return (
    <section className="chat-panel" aria-label="Agent chat">
      {error && <div className="chat-error">{error}</div>}
      <div className="chat-embed" ref={mountRef} />
    </section>
  )
}
