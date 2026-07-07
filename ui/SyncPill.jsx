// ----------------------------------------------------------------------
// Sync pill. Observable states:
//   offline → "Offline"
//   online  → null (idle steady state — don't clutter the surface with a
//                  persistent "Saved" sticker or transient pending count).
// hasRuntime=false (older shell without the offline runtime) means
// writes go straight to the server with no outbox to surface; we
// hide the pill in that mode rather than fabricate a queue depth.
// ----------------------------------------------------------------------
export function SyncPill({ online, hasRuntime }) {
  if (!hasRuntime) return null
  // Only surface the genuinely actionable state: offline. Local saves are
  // instant and reliable, so an outbox count ("Saving · N pending") is
  // internal plumbing the owner shouldn't have to read — and it flickered on
  // every keystroke. A clean, online editor shows nothing.
  if (online) return null
  return (
    <div
      className="sync-pill sync-pill--offline"
      role="status"
      aria-live="polite"
      title="Changes save locally and sync when you're back online."
    >
      <span className="sync-pill-dot" aria-hidden="true" />
      Offline
    </div>
  )
}
