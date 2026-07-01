// Spinner shown in the Build button while a compile runs (CSS animation on
// .building-spin). Same component as Web Studio's.
/* mobius-ui:BuildingIndicator v1 — keep in sync with app-webstudio */
export function BuildingIndicator({ size = 20 }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round"
      strokeLinejoin="round" aria-hidden className="building-spin">
      <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
    </svg>
  )
}
/* /mobius-ui:BuildingIndicator */
