import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { DEFAULT_PROJECT_ID } from '../constants.js'
import { buildTree } from '../domain.js'
import { ContextMenu } from './ContextMenu.jsx'
import { FileNode } from './FileNode.jsx'
import { NewFileIcon } from './NewFileIcon.jsx'
import { NewFolderIcon } from './NewFolderIcon.jsx'
import { PencilIcon } from './PencilIcon.jsx'
import { PlusIcon } from './PlusIcon.jsx'
import { ProjectSelector } from './ProjectSelector.jsx'
import { TrashIcon } from './TrashIcon.jsx'
import { UploadIcon } from './UploadIcon.jsx'

// Left slide-in file drawer (VSCode explorer shape): a panel that
// transforms in from the left edge over a dimming backdrop, opened by
// the app-logo toggle in the top bar. It is ALWAYS mounted (the `--open` class
// drives the transform), so the slide animation plays both ways and the
// tree state survives a close/reopen.
//
// `canMutate` is false until the file index has been confirmed against
// the server (App owns the check). While false we disable add/delete so
// the user can't queue an index write derived from an unconfirmed list —
// the handler refuses too, but greying the buttons is the honest surface
// rather than a tap that pops an explanatory modal.
export function FileNavPanel({
  open, onClose, files, selectedPath, onSelect, canMutate,
  onCreateFile, onCreateFolder, onDeleteFile, onDeleteFolder,
  onUpload, onMove, onRename, mainPath, onSetMain, returnFocusRef,
  projects, projectsLoaded, activeProjectId, onSwitchProject, onNewProject, onRenameProject, onDeleteProject,
  renamingId, onCommitProjectRename, onCancelProjectRename,
  pinned = false,
}) {
  // On desktop (>=860px) the panel is a docked rail while open. It still obeys
  // the same logo toggle as the overlay drawer, so `open` — not `pinned` — is
  // the single source of truth for visibility and accessibility.
  const shown = open
  const root = useMemo(() => buildTree(files), [files])
  const treeRef = useRef(null)
  const drawerRef = useRef(null)
  const dragStart = useRef(null) // { x, y } or null
  const prevOpenRef = useRef(open)

  // Swipe-left-to-close, ported faithfully from the Möbius shell Drawer:
  // touchstart captures the origin (only while open + single touch),
  // touchmove drags the panel 1:1 with the finger when the gesture is
  // dominantly horizontal-left, touchend either closes (>=70px past origin
  // AND horizontal-dominant) or snaps back. The CSS transition is disabled
  // mid-drag via `file-drawer--dragging` so the panel tracks the finger
  // without easing; on release the normal transform-transition animates the
  // snap/close. Scrim-click-to-close stays the separate, intact path.
  const drawerWidth = useCallback(() => {
    const el = drawerRef.current
    if (el && el.offsetWidth) return el.offsetWidth
    return Math.min(window.innerWidth * 0.78, 320)
  }, [])

  const onTouchStart = useCallback((e) => {
    if (pinned || !open || e.touches.length !== 1) return
    dragStart.current = { x: e.touches[0].clientX, y: e.touches[0].clientY }
  }, [open, pinned])

  const onTouchMove = useCallback((e) => {
    if (!dragStart.current || e.touches.length !== 1) return
    const dx = e.touches[0].clientX - dragStart.current.x
    const dy = e.touches[0].clientY - dragStart.current.y
    if (dx < 0 && Math.abs(dx) > Math.abs(dy) * 1.15) {
      const el = drawerRef.current
      if (!el) return
      el.classList.add('file-drawer--dragging')
      el.style.transform = `translateX(${Math.max(dx, -drawerWidth())}px)`
    }
  }, [drawerWidth])

  const onTouchEnd = useCallback((e) => {
    if (!dragStart.current) return
    const t = e.changedTouches[0]
    const dx = t.clientX - dragStart.current.x
    const dy = t.clientY - dragStart.current.y
    const shouldClose = dx < -70 && Math.abs(dx) > Math.abs(dy) * 1.35
    const el = drawerRef.current
    if (el) {
      el.classList.remove('file-drawer--dragging')
      if (shouldClose) {
        // Animate from the drag position to closed, then clear the inline
        // transform after the transition so the next open doesn't start from
        // translateX(-100%) inline (which would fight .file-drawer--open).
        el.style.transform = 'translateX(-100%)'
        const cleanup = () => {
          if (el) el.style.transform = ''
          el.removeEventListener('transitionend', cleanup)
        }
        el.addEventListener('transitionend', cleanup, { once: true })
      } else {
        // Snap back to open: clearing the inline transform lets the
        // .file-drawer--open class's translateX(0) take over with the
        // transition running from the drag position.
        el.style.transform = ''
      }
    }
    dragStart.current = null
    if (shouldClose) onClose?.()
  }, [onClose])

  // touchcancel positions are unreliable (clientX can be 0 or stale);
  // treat cancel as "snap back, don't close" — never evaluate the threshold.
  const onTouchCancel = useCallback(() => {
    const el = drawerRef.current
    if (el) {
      el.classList.remove('file-drawer--dragging')
      el.style.transform = ''
    }
    dragStart.current = null
  }, [])
  // Hidden inputs the Upload buttons click programmatically. Two separate
  // inputs because `webkitdirectory` and a plain multi-file picker can't share
  // one element — the directory flag turns the whole picker into folder mode.
  const fileInputRef = useRef(null)
  const folderInputRef = useRef(null)
  // The open context menu: {x, y, path, isFolder} or null.
  const [ctx, setCtx] = useState(null)
  const closeCtx = useCallback(() => setCtx(null), [])
  // Close the menu when the drawer closes so it can't outlive its anchor.
  useEffect(() => { if (!open) setCtx(null) }, [open])

  const treeItems = useCallback(() => {
    if (!treeRef.current) return []
    return Array.from(treeRef.current.querySelectorAll('[role="treeitem"]'))
  }, [])

  const focusTreeItem = useCallback((item) => {
    if (item && typeof item.focus === 'function') item.focus()
  }, [])

  const focusSelectedOrFirst = useCallback(() => {
    const items = treeItems()
    if (items.length === 0) return
    const selected = selectedPath
      ? items.find((item) => item.getAttribute('data-tree-path') === selectedPath)
      : null
    focusTreeItem(selected || items[0])
  }, [focusTreeItem, selectedPath, treeItems])

  useEffect(() => {
    // Pinned (desktop rail) never opens/closes, so don't auto-move focus into
    // it on mount or yank focus back to the toggle — it's just part of the page.
    if (pinned) { prevOpenRef.current = open; return }
    const wasOpen = prevOpenRef.current
    prevOpenRef.current = open
    if (open && !wasOpen) {
      const raf = requestAnimationFrame(focusSelectedOrFirst)
      return () => cancelAnimationFrame(raf)
    }
    if (!open && wasOpen) {
      returnFocusRef?.current?.focus?.()
    }
  }, [focusSelectedOrFirst, open, returnFocusRef, pinned])

  const handleTreeFocus = useCallback((event) => {
    if (event.target === treeRef.current) focusSelectedOrFirst()
  }, [focusSelectedOrFirst])

  const handleTreeKeyDown = useCallback((event) => {
    if (event.defaultPrevented) return
    const current = event.target.closest?.('[role="treeitem"]')
    if (!current || !treeRef.current?.contains(current)) return
    const items = treeItems()
    const index = items.indexOf(current)
    if (index < 0) return

    if (event.key === 'ArrowDown') {
      event.preventDefault()
      focusTreeItem(items[Math.min(index + 1, items.length - 1)])
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      focusTreeItem(items[Math.max(index - 1, 0)])
    } else if (event.key === 'Home') {
      event.preventDefault()
      focusTreeItem(items[0])
    } else if (event.key === 'End') {
      event.preventDefault()
      focusTreeItem(items[items.length - 1])
    } else if (event.key === 'ArrowRight') {
      if (current.getAttribute('aria-expanded') === 'true') {
        const level = Number(current.getAttribute('aria-level') || '0')
        const child = items.slice(index + 1).find((item) => (
          Number(item.getAttribute('aria-level') || '0') > level
        ))
        if (child) {
          event.preventDefault()
          focusTreeItem(child)
        }
      }
    } else if (event.key === 'ArrowLeft') {
      const parentPath = current.getAttribute('data-parent-path')
      if (parentPath) {
        const parent = items.find((item) => item.getAttribute('data-tree-path') === parentPath)
        if (parent) {
          event.preventDefault()
          focusTreeItem(parent)
        }
      }
    }
  }, [focusTreeItem, treeItems])

  // Context actions. A .tex file additionally offers "Set as build target"
  // (unless it already is the target) so the user can pick which file Build
  // compiles, Overleaf-style. The choice persists to main.json and Build
  // writes it to build/target.txt.
  const ctxItems = ctx ? [
    ...(!ctx.isFolder && ctx.path.endsWith('.tex') && ctx.path !== mainPath
      ? [{ label: 'Set as build target', onSelect: () => onSetMain(ctx.path) }]
      : []),
    { label: 'Rename', onSelect: () => onRename(ctx.path) },
    {
      label: 'Delete',
      danger: true,
      onSelect: () => (ctx.isFolder ? onDeleteFolder(ctx.path) : onDeleteFile(ctx.path)),
    },
  ] : []

  return (
    <>
      {/* No scrim for the pinned desktop rail — it doesn't overlay content. */}
      {!pinned && (
        <div
          className={`drawer-scrim ${open ? 'drawer-scrim--open' : ''}`}
          onClick={onClose}
          aria-hidden="true"
        />
      )}
      <aside
        ref={drawerRef}
        className={`file-drawer ${open ? 'file-drawer--open' : ''} ${pinned ? 'file-drawer--pinned' : ''}`}
        aria-label="File tree"
        aria-hidden={!shown}
        inert={!shown ? true : undefined}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onTouchCancel={onTouchCancel}
      >
        <div className="project-row">
          <ProjectSelector
            projects={projects}
            projectsLoaded={projectsLoaded}
            activeProjectId={activeProjectId}
            onSwitchProject={onSwitchProject}
            renamingId={renamingId}
            onCommitRename={onCommitProjectRename}
            onCancelRename={onCancelProjectRename}
          />
          <div className="project-row-actions">
            <button className="icon-btn" onClick={onNewProject} disabled={!projectsLoaded} title="New project" aria-label="New project"><PlusIcon size={18} /></button>
            <button className="icon-btn" onClick={() => onRenameProject(activeProjectId)} disabled={!projectsLoaded} title="Rename project" aria-label="Rename project"><PencilIcon size={15} /></button>
            <button className="icon-btn icon-btn--danger" onClick={() => onDeleteProject(activeProjectId)} disabled={!projectsLoaded || activeProjectId === DEFAULT_PROJECT_ID || projects.length <= 1} title="Delete project" aria-label="Delete project"><TrashIcon size={15} /></button>
          </div>
        </div>
        <div className="drawer-actions">
          <span className="files-label">Files</span>
          <div className="files-actions">
            <button className="icon-btn" onClick={onCreateFile} disabled={!canMutate} title="New file" aria-label="New file"><NewFileIcon size={17} /></button>
            <button className="icon-btn" onClick={onCreateFolder} disabled={!canMutate} title="New folder" aria-label="New folder"><NewFolderIcon size={17} /></button>
            <button className="icon-btn" onClick={() => fileInputRef.current && fileInputRef.current.click()} disabled={!canMutate} title="Upload" aria-label="Upload"><UploadIcon size={17} /></button>
          </div>
          {/* Hidden file/folder pickers. Materialise the FileList into a real
              array SYNCHRONOUSLY before resetting input.value: onUpload is async
              (it awaits before reading the list), and `e.target.value = ''`
              empties the live FileList the input still owns — so capturing the
              reference and resetting first would hand the uploader an
              already-emptied list and silently upload nothing. The reset still
              runs (so re-picking the same file fires a change event); it just
              runs after we've copied the entries out. */}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            style={{ display: 'none' }}
            onChange={(e) => {
              const fl = Array.from(e.target.files || [])
              e.target.value = ''
              onUpload(fl, { asFolder: false })
            }}
          />
          <input
            ref={folderInputRef}
            type="file"
            multiple
            webkitdirectory=""
            directory=""
            style={{ display: 'none' }}
            onChange={(e) => {
              const fl = Array.from(e.target.files || [])
              e.target.value = ''
              onUpload(fl, { asFolder: true })
            }}
          />
        </div>
        {!canMutate && (
          <div className="drawer-syncing" role="status">
            Loading your files… add, upload, and delete unlock once they sync.
          </div>
        )}
        <div
          ref={treeRef}
          className="drawer-tree"
          role={files.length ? 'tree' : undefined}
          aria-label={files.length ? 'Project files' : undefined}
          tabIndex={files.length ? 0 : undefined}
          onFocus={handleTreeFocus}
          onKeyDown={handleTreeKeyDown}
        >
          {files.length === 0 ? (
            canMutate ? (
              <div className="drawer-empty">
                Upload a file, or open the project chat to tell the agent what to build.
              </div>
            ) : null
          ) : (
            <FileNode
              node={(root.children.size === 1 && root.children.has('files')) ? root.children.get('files') : root}
              selectedPath={selectedPath}
              onSelect={(p) => { onSelect(p); if (!pinned) onClose() }}
              depth={-1}
              onContextMenu={setCtx}
              onMoveInto={onMove}
              mainPath={mainPath}
              onSetMain={onSetMain}
              openMenuPath={ctx ? ctx.path : null}
            />
          )}
        </div>
        {ctx && (
          <ContextMenu x={ctx.x} y={ctx.y} items={ctxItems} onClose={closeCtx} />
        )}
      </aside>
    </>
  )
}
