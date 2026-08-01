import { fileKind } from '../domain.js'
import { File, FileCode, FileDocument, FileImage } from '@openai/apps-sdk-ui/components/Icon'

export function FileGlyph({ name, size = 16 }) {
  const kind = fileKind(name)
  const Glyph = kind === 'image'
    ? FileImage
    : kind === 'tex' ? FileCode
      : ['md', 'pdf'].includes(kind) ? FileDocument : File
  return <Glyph width={size} height={size} aria-hidden="true" />
}
/* mobius-ui:FileGlyph end */

// Bare chevron for folder rows — rotates via CSS when the folder is expanded.
