import { fileKind } from '../domain.js'

export function FileGlyph({ name, size = 16 }) {
  const kind = fileKind(name)
  const sharedProps = {
    viewBox: '0 0 24 24', width: size, height: size, fill: 'none',
    stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round',
    strokeLinejoin: 'round', 'aria-hidden': true,
  }
  if (kind === 'image') {
    return (
      <svg {...sharedProps}>
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <circle cx="8.5" cy="9.5" r="1.5" />
        <path d="m21 16-5-5L5 20" />
      </svg>
    )
  }
  const page = <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
  const fold = <path d="M14 3v5h5" />
  return (
    <svg {...sharedProps}>
      {page}
      {fold}
      {kind === 'tex' && <path d="M9 13h6M9 16h4M10.5 10l3 0" />}
      {kind === 'md' && <path d="M9 17V11l2 2 2-2v6M15 11h1" />}
      {kind === 'pdf' && <path d="M9 14c0-1.1.9-2 2-2h.5c.8 0 1.5.7 1.5 1.5S12.3 15 11.5 15H11v2" />}
      {kind === 'file' && <path d="M9 14h6M9 17h4" />}
    </svg>
  )
}
/* mobius-ui:FileGlyph end */

// Bare chevron for folder rows — rotates via CSS when the folder is expanded.
