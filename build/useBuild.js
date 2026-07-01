import { useCallback, useEffect, useRef, useState } from 'react'
import { BUILD_POLL_MS, BUILD_TIMEOUT_MS, DEFAULT_PROJECT_ID } from '../constants.js'

// ----------------------------------------------------------------------
// Build controller. Owns the source→PDF compile state machine and the
// poll loop. The actual compile runs server-side (tectonic via build.sh,
// triggered by run-job); the app's job is to set the target, kick the run,
// then poll build/status.json until the script writes a verdict.
//
// State machine:
//   idle → building → done   (status.json says {status:'done', pdf,...})
//                   → error  (status.json says {status:'error', log} OR
//                             run-job refused OR the 120s cap elapsed)
//
// status.json 404s the entire time the build is running (the script only
// writes it at the end), so a 404 during polling is "still building", not
// a failure. We cap at BUILD_TIMEOUT_MS so a wedged/never-finishing build
// doesn't poll forever. Exactly one poll timer exists at a time: starting
// a build clears any prior timer first, and unmount clears it too — there
// are never concurrent builds (the Build button is disabled while
// building, and `build()` early-returns if already building).
// ----------------------------------------------------------------------
export function useBuild({ appId, token, storage, online, activeProjectId }) {
  const [buildStatus, setBuildStatus] = useState('idle') // idle|building|done|error
  const [buildLog, setBuildLog] = useState('')
  // Which .tex the current/last build is FOR. The hook tracks one build at a
  // time; this lets the viewer scope "Building…" / "Build failed" to the doc
  // that's actually compiling, so switching to a different doc mid-build
  // doesn't mislabel it.
  const [buildDoc, setBuildDoc] = useState(null)
  // Map of source .tex path → its built .pdf path, so the viewer can show a
  // PDF tab only for documents that have actually been compiled or restored
  // from a previous successful build.
  // doc path → { pdf, ver }. `ver` is a monotonic per-build token (see
  // finishDone) so the viewer refetches even when the compiled path is
  // unchanged across rebuilds.
  const [pdfByDoc, setPdfByDoc] = useState({})
  const pollRef = useRef(null)
  const deadlineRef = useRef(0)
  const buildGenerationRef = useRef(0)
  // Monotonic build counter — sources the `ver` token in pdfByDoc.
  const buildSeqRef = useRef(0)
  // Synchronous in-flight guard. buildStatus lags a render, so it can't gate
  // a rapid double-click on the dirty-file path (build() is deferred behind an
  // async save); this ref flips before any await and is the real guard.
  const buildingRef = useRef(false)

  const clearPoll = useCallback(() => {
    buildGenerationRef.current += 1
    if (pollRef.current) {
      clearTimeout(pollRef.current)
      pollRef.current = null
    }
    deadlineRef.current = 0
    // An orphaned in-flight build's poll will never reach finishDone/Error
    // (its generation is now stale), so its buildingRef would stay stuck true
    // and block all future builds. Release it here.
    buildingRef.current = false
  }, [])

  // Clear the timer on unmount so a poll can't fire into a dead component.
  useEffect(() => clearPoll, [clearPoll])

  useEffect(() => {
    clearPoll()
    buildingRef.current = false
    deadlineRef.current = 0
    buildSeqRef.current = 0
    setBuildStatus('idle')
    setBuildLog('')
    setBuildDoc(null)
    setPdfByDoc({})
  }, [clearPoll, storage])

  const finishDone = useCallback((doc, pdf) => {
    clearPoll()
    buildingRef.current = false
    setBuildStatus('done')
    setBuildLog('')
    if (doc && pdf) {
      // Stamp a fresh token on every successful build. The compiled path is
      // deterministic per doc (files/x.tex always → files/x.pdf), so a rebuild
      // yields the identical string; storing the path alone made finishDone a
      // no-op (prev[doc] === pdf) and the viewer kept the FIRST build's blob.
      // The token gives each build a new value identity so PdfPreview refetches.
      const ver = (buildSeqRef.current += 1)
      setPdfByDoc((prev) => ({ ...prev, [doc]: { pdf, ver } }))
      // Pull the just-built PDF from the server BEFORE PdfPreview re-reads it,
      // so the runtime's cache-first blob mirror holds the new bytes (and not
      // the prior build's tombstoned/stale blob) when the viewer asks. Fire-
      // and-forget: PdfPreview's own getBlob is the real read; this just warms
      // the cache so the fresh PDF shows immediately on build-done.
      storage.getBlobFresh(pdf).catch(() => {})
    }
  }, [clearPoll, storage])

  const finishError = useCallback((log) => {
    clearPoll()
    buildingRef.current = false
    setBuildStatus('error')
    setBuildLog(log || 'Build failed.')
  }, [clearPoll])

  // One poll tick: read build/status.json. 404/null → still building (or the
  // cap elapsed → error). A verdict object → done/error. onDone is called
  // with the built pdf path so the caller can flip the viewer + register it.
  const poll = useCallback(async (doc, onDone, generation) => {
    if (generation !== buildGenerationRef.current) return
    if (Date.now() > deadlineRef.current) {
      finishError('Build timed out (over 2 minutes). The first build downloads '
        + 'LaTeX packages and can be slow — try again, or check the .tex compiles.')
      return
    }
    let status = null
    try {
      status = await storage.get('build/status.json')
    } catch (e) {
      // Transient read failure — keep polling; the deadline still bounds us.
      status = null
    }
    if (generation !== buildGenerationRef.current) return
    if (status && typeof status === 'object' && status.status) {
      // The verdict echoes the target it was built FROM. build/target.txt +
      // build/status.json are one shared pair per app, so a build kicked from
      // another tab/device for a DIFFERENT doc can land its verdict here.
      // If it isn't the doc we're waiting on, ignore it and keep polling for
      // ours — otherwise we'd map a sibling's PDF onto this doc. (Verdicts
      // predating the `target` field have none and are accepted as before.)
      if (status.target && status.target !== doc) {
        pollRef.current = setTimeout(() => poll(doc, onDone, generation), BUILD_POLL_MS)
        return
      }
      if (status.status === 'done') {
        finishDone(doc, status.pdf)
        if (typeof onDone === 'function' && status.pdf) onDone(doc, status.pdf)
        return
      }
      finishError(status.log || 'Build failed.')
      return
    }
    // Not ready yet (404 → null). Schedule the next tick.
    pollRef.current = setTimeout(() => poll(doc, onDone, generation), BUILD_POLL_MS)
  }, [storage, finishDone, finishError])

  // Kick a build for `doc` (a "files/<name>.tex" path). onDone fires once the
  // PDF is ready. Guards against concurrent builds + offline.
  const build = useCallback(async (doc, onDone) => {
    // Re-entry guard (synchronous, before any await) — see buildingRef. Two
    // near-simultaneous build() calls (rapid double-click on a dirty .tex, whose
    // build is deferred behind an async save while buildStatus is still 'idle')
    // would otherwise both write target.txt and both POST run-job.
    if (buildingRef.current) return
    if (!doc || !doc.endsWith('.tex')) return
    if (!online) {
      finishError('You are offline. Building needs a connection — reconnect and try again.')
      return
    }
    clearPoll()
    buildingRef.current = true
    const generation = buildGenerationRef.current
    setBuildDoc(doc)
    setBuildStatus('building')
    setBuildLog('')
    try {
      // 0. Clear any verdict from a PRIOR build. The script only writes
      // status.json when tectonic finishes, so between run-job and that
      // write the OLD status.json still exists — the first poll would read
      // last build's done/error and finish instantly with stale results.
      // Removing it first means a poll sees 404 (still building) until the
      // new run lands a fresh verdict. A 404 on the remove is fine.
      await storage.remove('build/status.json')
      // 1. Tell the build script which file to compile.
      await storage.setText('build/target.txt', doc)
      // 2. Kick the server-side job. 202 = accepted; anything else is fatal.
      const runJobUrl = activeProjectId === DEFAULT_PROJECT_ID
        ? `/api/apps/${appId}/run-job`
        : `/api/apps/${appId}/run-job?projectId=${encodeURIComponent(activeProjectId)}`
      const r = await fetch(runJobUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      if (r.status !== 202) {
        let detail = ''
        try { detail = (await r.json()).detail || '' } catch { /* non-JSON body */ }
        finishError(
          `Could not start the build (server returned ${r.status}${detail ? `: ${detail}` : ''}).`,
        )
        return
      }
      // 3. Poll status.json until the script writes its verdict.
      deadlineRef.current = Date.now() + BUILD_TIMEOUT_MS
      pollRef.current = setTimeout(() => poll(doc, onDone, generation), BUILD_POLL_MS)
    } catch (e) {
      finishError((e && e.message) ? e.message : 'Build failed to start.')
    }
  }, [activeProjectId, appId, token, storage, online, clearPoll, finishError, poll])

  const rememberPdf = useCallback((doc, pdf) => {
    if (buildingRef.current) return
    if (!doc || !pdf) return
    setBuildDoc(doc)
    finishDone(doc, pdf)
  }, [finishDone])

  return {
    buildStatus, buildLog, buildDoc, pdfByDoc, build, rememberPdf,
    clearPoll,
    // Surfaced so the App can drop a doc's PDF mapping when the file is
    // deleted/renamed (the pdf path itself is just another tree entry).
    forgetDoc: useCallback((doc) => {
      setPdfByDoc((prev) => {
        if (!(doc in prev)) return prev
        const next = { ...prev }
        delete next[doc]
        return next
      })
    }, []),
    // Re-key the map across a move/rename. A folder rename re-parents every
    // child AND the move route relocates the compiled .pdf files with them, so
    // both the doc KEY and the stored .pdf path run through the same prefix
    // rewrite — otherwise the viewer loses the just-built PDF for files inside
    // the renamed folder (the old key no longer matches the selection).
    rewriteDocs: useCallback((rewrite) => {
      setPdfByDoc((prev) => {
        const next = {}
        for (const [doc, entry] of Object.entries(prev)) {
          next[rewrite(doc)] = { ...entry, pdf: rewrite(entry.pdf) }
        }
        return next
      })
    }, []),
    // Drop every mapping under a deleted folder (entries are keyed by their
    // source .tex, which lives inside the folder).
    forgetUnder: useCallback((prefix) => {
      setPdfByDoc((prev) => {
        let changed = false
        const next = {}
        for (const [doc, entry] of Object.entries(prev)) {
          if (doc === prefix || doc.startsWith(`${prefix}/`)) { changed = true; continue }
          next[doc] = entry
        }
        return changed ? next : prev
      })
    }, []),
  }
}
