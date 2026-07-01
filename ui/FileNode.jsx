import { useCallback, useState } from 'react'
import { ChevronIcon } from './ChevronIcon.jsx'
import { FileGlyph } from './FileGlyph.jsx'
import { KebabIcon } from './KebabIcon.jsx'
import { ToolIcon } from './ToolIcon.jsx'
import { useLongPress } from './useLongPress.js'

export function FileNode({
  node, selectedPath, onSelect, depth,
  onContextMenu, onMoveInto, mainPath, onSetMain, openMenuPath, parentPath = '',
}) {
  const [expanded, setExpanded] = useState(true)
  const [dropActive, setDropActive] = useState(false)
  const isFolder = !(node.children.size === 0 && node.isFile)
  // The per-row ⋯ menu is open for THIS row when the open context-menu's
  // anchor path matches ours. Mirrors the shell drawer's Radix trigger, which
  // gets data-state="open" so the lit/accent-tinted kebab visibly belongs to
  // the row whose menu is showing.
  const menuOpen = openMenuPath === node.path
  const longPress = useLongPress((cx, cy) => {
    onContextMenu({ x: cx, y: cy, path: node.path, isFolder })
  })
  // Open the per-row action menu (Set main / Rename / Delete) anchored at the
  // kebab button. Same menu the right-click / long-press gesture opens — the
  // visible ⋯ button just makes those actions (the destructive Delete in
  // particular) discoverable without a hidden long-press.
  const openMenuFromButton = useCallback((e, isFolderItem) => {
    e.preventDefault()
    e.stopPropagation()
    if (openMenuPath === node.path) { onContextMenu(null); return }
    const r = e.currentTarget.getBoundingClientRect()
    onContextMenu({ x: r.right, y: r.bottom, path: node.path, isFolder: isFolderItem })
  }, [openMenuPath, node.path, onContextMenu])
  if (node.children.size === 0 && node.isFile) {
    const selected = node.path === selectedPath
    const isMain = node.path === mainPath
    const isTex = node.path.toLowerCase().endsWith('.tex')
    // Discoverable "set as build target" affordance: a visible target button
    // on every .tex that isn't already the build target, alongside the existing
    // right-click / long-press context-menu path (which still works). The
    // current target is marked instead with a single compact accent glyph (the
    // bullseye) — no text chip. It is a SIBLING of the row <button> (next to the
    // kebab), not nested inside it: focusable content inside a <button> is
    // invalid HTML and pollutes the tree's roving-tabindex (the row buttons are
    // tabIndex={-1}). We stop propagation so tapping it sets the target without
    // also selecting/opening the file.
    const activateSetMain = (e) => {
      e.preventDefault()
      e.stopPropagation()
      if (onSetMain) onSetMain(node.path)
    }
    return (
      <div className="tree-row">
        <button
          type="button"
          className={`tree-file ${selected ? 'tree-file--selected' : ''}`}
          style={{ paddingLeft: `${10 + depth * 16}px` }}
          role="treeitem"
          aria-level={depth + 1}
          aria-selected={selected}
          tabIndex={-1}
          data-tree-path={node.path}
          data-parent-path={parentPath}
          data-tree-kind="file"
          onClick={() => onSelect(node.path)}
          // Draggable so a file can be dropped onto a folder (or the root) to
          // move it. dataTransfer carries the source path.
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData('text/mobius-path', node.path)
            e.dataTransfer.effectAllowed = 'move'
          }}
          onContextMenu={(e) => {
            e.preventDefault()
            onContextMenu({ x: e.clientX, y: e.clientY, path: node.path, isFolder: false })
          }}
          {...longPress}
        >
          <span className="tree-icon"><FileGlyph name={node.name} /></span>
          <span className="tree-name">{node.name}</span>
          {isMain && (
            <span className="tree-main-glyph" title="Build target — Build compiles this file" aria-label="Build target">
              <ToolIcon name="target" size={15} />
            </span>
          )}
        </button>
        {isTex && !isMain && onSetMain && (
          <button
            type="button"
            className="tree-set-main"
            aria-label="Set as build target"
            title="Set as build target (Build will compile this file)"
            onClick={activateSetMain}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') activateSetMain(e) }}
          >
            <ToolIcon name="target" size={16} />
          </button>
        )}
        <button
          type="button"
          className="tree-menu-btn"
          data-popover-trigger=""
          data-state={menuOpen ? 'open' : undefined}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-label={`Actions for ${node.name}`}
          title="File actions"
          onClick={(e) => openMenuFromButton(e, false)}
        >
          <KebabIcon />
        </button>
      </div>
    )
  }
  // Folder node — own row plus indented children. We filter `.keep`
  // entries before sorting: those exist only so empty folders survive
  // a backend that has no mkdir endpoint (handleCreateFolder writes
  // `files/<name>/.keep` to materialise the folder), and showing
  // them in the tree would just look like noise the user can't act
  // on. The path stays in files-index.json so the folder itself is
  // still visible as an intermediate node here.
  const sortedChildren = [...node.children.values()]
    .filter((c) => !(c.isFile && c.name === '.keep'))
    .sort((a, b) => {
      // Folders first, then files, both alphabetical. Folder = has
      // non-empty children and isn't itself a leaf file.
      const af = a.children.size > 0 && !a.isFile
      const bf = b.children.size > 0 && !b.isFile
      if (af !== bf) return af ? -1 : 1
      return a.name.localeCompare(b.name)
    })
  // Move the dragged file INTO this folder (or the root): keep its leaf name,
  // re-parent it under `destDir`. destDir is "" for the root, else the
  // folder's own path ("files/sub").
  const dropMove = (e, destDir) => {
    e.preventDefault()
    // The folder onDrop is a DOM descendant of the root container's onDrop, so a
    // drop onto a folder would otherwise bubble up and run the root move too —
    // targeting the already-moved source path and 404ing. Stop propagation here.
    e.stopPropagation()
    setDropActive(false)
    const from = e.dataTransfer.getData('text/mobius-path')
    if (!from) return
    const leaf = from.split('/').pop()
    // Root drops land back under files/ (the storage tree root for this app);
    // folder drops land under the folder. Either way the new path is
    // <dest>/<leaf>.
    const base = destDir || 'files'
    onMoveInto(from, `${base}/${leaf}`)
  }

  // Root folder (depth -1) renders just its children, no row of its own — but
  // the whole tree container is itself a drop target so a file can be moved
  // back out to the top level. The drop handler lives on the wrapper.
  if (depth < 0) {
    return (
      <div
        className={`tree-root ${dropActive ? 'tree-drop-active' : ''}`}
        onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setDropActive(true) }}
        onDragLeave={() => setDropActive(false)}
        onDrop={(e) => dropMove(e, node.path)}
      >
        {sortedChildren.map((c) => (
          <FileNode
            key={c.path}
            node={c}
            selectedPath={selectedPath}
            onSelect={onSelect}
            depth={0}
            onContextMenu={onContextMenu}
            onMoveInto={onMoveInto}
            mainPath={mainPath}
            onSetMain={onSetMain}
            openMenuPath={openMenuPath}
            parentPath=""
          />
        ))}
      </div>
    )
  }
  return (
    <>
      <div className="tree-row">
        <button
          type="button"
          className={`tree-folder ${dropActive ? 'tree-drop-active' : ''}`}
          style={{ paddingLeft: `${10 + depth * 16}px` }}
          role="treeitem"
          aria-level={depth + 1}
          aria-expanded={expanded}
          tabIndex={-1}
          data-tree-path={node.path}
          data-parent-path={parentPath}
          data-tree-kind="folder"
          onClick={() => setExpanded((e) => !e)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowRight' && !expanded) {
              e.preventDefault()
              setExpanded(true)
            } else if (e.key === 'ArrowLeft' && expanded) {
              e.preventDefault()
              setExpanded(false)
            }
          }}
          // Folders are drop targets for moves.
          onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setDropActive(true) }}
          onDragLeave={() => setDropActive(false)}
          onDrop={(e) => dropMove(e, node.path)}
          onContextMenu={(e) => {
            e.preventDefault()
            onContextMenu({ x: e.clientX, y: e.clientY, path: node.path, isFolder: true })
          }}
          {...longPress}
        >
          <span className={`tree-icon tree-chevron${expanded ? ' tree-chevron--open' : ''}`}><ChevronIcon /></span>
          <span className="tree-name">{node.name}/</span>
        </button>
        <button
          type="button"
          className="tree-menu-btn"
          data-popover-trigger=""
          data-state={menuOpen ? 'open' : undefined}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-label={`Actions for ${node.name} folder`}
          title="Folder actions"
          onClick={(e) => openMenuFromButton(e, true)}
        >
          <KebabIcon />
        </button>
      </div>
      {expanded && (
        <div role="group" className="tree-group">
          {sortedChildren.map((c) => (
            <FileNode
              key={c.path}
              node={c}
              selectedPath={selectedPath}
              onSelect={onSelect}
              depth={depth + 1}
              onContextMenu={onContextMenu}
              onMoveInto={onMoveInto}
              mainPath={mainPath}
              onSetMain={onSetMain}
              openMenuPath={openMenuPath}
              parentPath={node.path}
            />
          ))}
        </div>
      )}
    </>
  )
}
