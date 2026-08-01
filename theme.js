export const CSS = `
/* mobius-ui:Focus v1 -- shared keyboard focus ring (WCAG 2.4.7); never bare outline:none */
:where(button,a,input,textarea,select,summary,[role="button"],[tabindex]:not([tabindex="-1"])):focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
/* /mobius-ui:Focus */

/* mobius-ui:Root v1 */
.latex-root {
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
  width: 100%;
  max-width: 100%;
  background: var(--bg, #0d0d0d);
  color: var(--text, #ececec);
  font-family: var(--font, Inter, ui-sans-serif, system-ui, sans-serif);
  --code-comment: var(--muted);
  --code-string: color-mix(in srgb, #42a85d 76%, var(--text));
  --code-keyword: color-mix(in srgb, var(--accent) 74%, var(--text));
  --code-literal: color-mix(in srgb, #1598bc 78%, var(--text));
  --code-number: color-mix(in srgb, #d77a24 78%, var(--text));
  --code-tag: color-mix(in srgb, #d94e63 76%, var(--text));
  overflow: hidden;
  -webkit-font-smoothing: antialiased;
  -webkit-tap-highlight-color: transparent;
  text-rendering: geometricPrecision;
  overscroll-behavior: contain;
}
/* /mobius-ui:Root */

/* mobius-ui:Scrollskin v2 — keep in sync; hidden by default, content stays scrollable. */
.latex-root :where(.build-log, .pdf-viewer, .project-menu, .drawer-tree, .cm-scroller) {
  scrollbar-width: none;
  -ms-overflow-style: none;
}
.latex-root :where(.build-log, .pdf-viewer, .project-menu, .drawer-tree, .cm-scroller)::-webkit-scrollbar {
  display: none;
  width: 0;
  height: 0;
}
/* /mobius-ui:Scrollskin */

/* mobius-ui:Toolbar v1 — keep in sync with app-webstudio (ws- prefixed) */
/* Two-zone bar: a left zone (drawer toggle + filename) that flexes +
   truncates, and a right zone (source/file toggle, Build, sync, Chat) sized
   to its content. The chat toggle moved from a former centre zone to the far
   right, so the centre column is gone. */
.top-bar {
  flex: 0 0 auto;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  min-height: 48px;
  /* Top-pinned bar: clear the notch / Dynamic Island and pad the sides past
     the rounded-corner / gesture insets on a full-screen PWA. */
  padding: max(6px, env(safe-area-inset-top)) max(10px, env(safe-area-inset-right)) 6px max(10px, env(safe-area-inset-left));
  background: var(--surface);
  border-bottom: 1px solid var(--border);
  user-select: none;
}
.top-zone {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.top-zone--left { justify-content: flex-start; }
.top-zone--right { justify-content: flex-end; }
/* The logo-as-toggle: a bare 44px tap target holding the app icon, so the
   logo (not a hamburger) opens the file drawer — mirroring the Möbius shell. */
.nav-toggle {
  flex: 0 0 auto;
  width: 44px;
  height: 44px;
  min-height: 44px;
  border-radius: 8px;
  border: none;
  background: transparent;
  color: var(--text);
  font-size: 16px;
  cursor: pointer;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  -webkit-tap-highlight-color: transparent;
  -webkit-user-select: none;
  user-select: none;
  touch-action: manipulation;
  transition: background 0.14s ease, color 0.14s ease, transform 0.08s ease;
}
/* Brand drawer-toggle feedback: neutral wash on hover/focus. */
.nav-toggle:focus:not(:focus-visible) { outline: none; }
@media (hover: hover) {
  .nav-toggle:hover {
    background: var(--surface2, var(--bg-alt, var(--surface)));
  }
}
.nav-toggle:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
  background: var(--surface2, var(--bg-alt, var(--surface)));
}
.nav-toggle:active {
  background: var(--surface2, var(--bg-alt, var(--surface)));
  transform: scale(0.94);
}
.nav-toggle[aria-expanded="true"] {
  color: var(--accent);
  background: var(--accent-dim, color-mix(in srgb, var(--accent) 12%, transparent));
}
/* The real app icon as the brand mark inside the drawer toggle. */
.latex-brand-icon {
  width: 34px;
  height: 34px;
  border-radius: 8px;
  object-fit: cover;
  flex-shrink: 0;
  display: block;
}
/* Accent-dot fallback shown when the install has no custom icon (route 404s). */
.latex-brand-fallback {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--accent);
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.top-title {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  font-weight: 600;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.top-path {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.top-path--muted { color: var(--muted); font-weight: 400; }
/* Icon-only Build button: a square tap target with the play glyph centred. */
.toolbar-btn {
  width: 44px;
  height: 44px;
  min-height: 44px;
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--text);
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
  touch-action: manipulation;
}
.toolbar-btn--primary {
  background: var(--accent-hover, var(--accent));
  border-color: var(--accent-hover, var(--accent));
  color: var(--accent-fg);
}
.toolbar-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
.toolbar-btn:active { background: var(--surface2, var(--surface)); }
.toolbar-btn--primary:active { background: color-mix(in srgb, var(--accent) 80%, #000); }
@media (hover: hover) {
  .toolbar-btn:hover:not(:disabled) { background: var(--surface2, var(--surface)); }
  .toolbar-btn--primary:hover:not(:disabled) { background: color-mix(in srgb, var(--accent) 85%, #000); }
}
.chat-toggle-btn[aria-pressed="true"] {
  background: color-mix(in srgb, var(--accent) 18%, var(--surface));
  color: var(--accent);
  border-color: color-mix(in srgb, var(--accent) 40%, var(--border));
}
/* Build-button spinner (BuildingIndicator) — same recipe as app-webstudio. */
@keyframes building-spin { to { transform: rotate(360deg); } }
.building-spin {
  animation: building-spin 1.1s linear infinite;
  transform-origin: center;
}

/* ---- source/preview view toggle: ONE segmented control. The border +
   radius live on the .seg-toggle WRAPPER, the two .seg-btn segments are
   borderless and share a transparent track, so the active segment reads as
   a moving fill inside a single pill (not two separate buttons). ---- */
.seg-toggle {
  display: inline-flex;
  flex: 0 0 auto;
  gap: 2px;
  padding: 2px;
  border: 1px solid var(--border);
  border-radius: 9px;
  background: var(--bg);
}
.seg-btn {
  width: 44px;
  height: 44px;
  min-height: 44px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
  touch-action: manipulation;
}
/* Active segment: a neutral raised fill (surface2) over the wrapper's track,
   the standard segmented-control "selected" look — no accent tint. */
.seg-btn--active {
  background: var(--surface2, var(--surface));
  color: var(--text);
}
.seg-btn:active { background: var(--surface2, var(--surface)); }
@media (hover: hover) {
  .seg-btn:hover:not(.seg-btn--active) { background: var(--surface); color: var(--text); }
}

/* ---- body: content area + bounded chat, stacked ----
   position: relative so the absolutely-positioned file drawer + its
   backdrop resolve against THIS box — i.e. they overlay only the area
   below the top bar, leaving the logo toggle always tappable. */
.body {
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg);
  overflow: hidden;
}
.content {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--bg);
}
/* ---- source editor (CodeMirror) ---- */
.cm-host {
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
  background: var(--bg);
}

/* Managed .json files render read-only with an inline notice above the
   source — editing them as text/plain would corrupt them for typed-JSON
   readers, so the editor never autosaves them. */
.editor-readonly {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
}
.readonly-note {
  flex: 0 0 auto;
  padding: 8px 16px;
  font-size: 12px;
  line-height: 1.4;
  color: var(--muted);
  background: var(--surface);
  border-bottom: 1px solid var(--border);
}

/* ---- empty / notes ---- */
.preview-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  text-align: center;
  color: var(--muted);
  gap: 8px;
  padding: 24px;
}
.preview-empty-title { font-size: 26px; font-weight: 700; color: var(--text); }
.preview-empty-body { font-size: 14px; line-height: 1.5; max-width: 320px; }

.preview-note {
  color: var(--muted);
  font-size: 13px;
  padding: 24px 18px;
  text-align: center;
  line-height: 1.55;
}
.preview-note b { color: var(--text); }
.build-note { padding: 32px 18px; }
.preview-retry-btn {
  margin-top: 12px;
  min-height: 44px;
  padding: 8px 18px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--text);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}
.preview-retry-btn:active { background: var(--surface2, var(--surface)); }

/* ---- build failure ---- */
.build-error {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 16px 18px;
}
.build-error-title {
  font-weight: 700;
  color: var(--danger, var(--accent));
  font-size: 14px;
}
.build-log {
  max-height: 60vh;
  overflow: auto;
  /* Keep flick-scroll inside the log; do not chain to the page behind it. */
  overscroll-behavior: contain;
  margin: 0;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  color: var(--text);
  /* Same JetBrains Mono token as the CodeMirror scroller it sits beside, so
     the build log doesn't diverge from the source editor's typeface. */
  font: 12px/1.5 var(--mono, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace);
  white-space: pre-wrap;
  word-break: break-word;
}

/* ---- image preview ---- */
.img-preview {
  display: block;
  max-width: 100%;
  margin: 18px auto;
  border-radius: 6px;
}

/* ---- pdf.js canvas viewer ---- */
/* Stage = positioning context for the floating zoom toolbar; the scroller
   below it holds ONLY the pages host, so all scrolled content scales
   uniformly with the zoom (keeps the anchored-zoom scroll math exact). */
.pdf-stage {
  position: relative;
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.pdf-viewer {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  background: var(--surface2, var(--surface));
  /* One-finger pan is the browser's own scrolling (both axes); only
     multi-touch (pinch) reaches our handlers. */
  touch-action: pan-x pan-y;
  overscroll-behavior: contain;
  position: relative;
  scrollbar-gutter: auto;
}
/* Control bar — a SOLID row that sits BELOW the scroller as its own flex
   line, so it never covers the PDF (owner feedback #5). It's outside the
   scroll content too, so the pages host stays the only scrolled element and
   the anchored-zoom scroll conversion stays exact. Zoom group on the left,
   download pushed to the right. */
.pdf-controlbar {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 4px 8px;
  background: var(--surface);
  border-top: 1px solid var(--border);
  user-select: none;
  -webkit-user-select: none;
}
.pdf-zoom-group {
  display: flex;
  align-items: center;
  gap: 2px;
}
.pdf-ctl-btn {
  min-height: 44px;
  min-width: 44px;
  padding: 4px 10px;
  border-radius: 8px;
  border: none;
  background: none;
  color: var(--text);
  font-family: var(--font);
  font-size: 16px;
  font-weight: 600;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  -webkit-tap-highlight-color: transparent;
  touch-action: manipulation;
}
.pdf-ctl-btn:disabled { opacity: 0.35; cursor: default; }
.pdf-ctl-btn:active:not(:disabled) { background: var(--surface2, var(--surface)); }
@media (hover: hover) {
  .pdf-ctl-btn:hover:not(:disabled) { background: color-mix(in srgb, var(--accent) 10%, transparent); }
}
/* The % readout button is slightly wider to fit the text. */
.pdf-zoom-pct {
  font-size: 13px;
  min-width: 56px;
  font-variant-numeric: tabular-nums;
}
/* Pages host. gap + padding are set inline (scaled with the zoom — see
   applyPageChrome). width: max-content + min-width: 100% so a zoomed-in host
   grows past the viewport and stays fully reachable by scrolling (a centered
   flex child wider than its scroller would clip its left edge). */
.pdf-pages {
  display: flex;
  flex-direction: column;
  align-items: center;
  width: max-content;
  min-width: 100%;
  box-sizing: border-box;
}
.pdf-page {
  display: block;
  border-radius: 4px;
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.28);
  background: #fff;
}

/* mobius-ui:FileTree v1 */
/* ---- file drawer ---- */
.drawer-scrim {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.35);
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.18s ease;
  z-index: 10;
}
.drawer-scrim--open { opacity: 1; pointer-events: auto; }
.file-drawer {
  position: absolute;
  top: 0;
  left: 0;
  bottom: 0;
  width: 78%;
  max-width: 320px;
  background: var(--surface);
  color: var(--text);
  border-right: 1px solid var(--border);
  transform: translateX(-100%);
  transition: transform 0.22s ease;
  z-index: 11;
  display: flex;
  flex-direction: column;
}
.file-drawer--open { transform: translateX(0); }
/* While the finger drags, kill the transform-transition so the panel tracks
   1:1; on release the inline class is removed and the normal transition
   animates the snap-back or close. Mirrors the shell's .drawer--dragging. */
.file-drawer--dragging { transition: none; }
.drawer-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 52px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border);
}
.drawer-head-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.drawer-title {
  font-size: 14px;
  font-weight: 700;
  color: var(--text);
  line-height: 1.2;
}
.project-picker {
  position: relative;
  flex: 0 1 auto;
  min-width: 0;
}
.project-trigger {
  max-width: 170px;
  min-height: 44px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 9px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg);
  color: var(--text);
  font: 650 12px/1.2 var(--font);
  cursor: pointer;
}
.latex-sr-only {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0;
}
.project-trigger svg {
  flex: 0 0 auto;
  transform: rotate(90deg);
  color: var(--muted);
}
.project-trigger-name {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.project-trigger[aria-expanded="true"] {
  color: var(--accent);
  background: var(--accent-dim, color-mix(in srgb, var(--accent) 12%, transparent));
  border-color: color-mix(in srgb, var(--accent) 40%, var(--border));
}
.project-trigger[aria-expanded="true"] svg {
  color: var(--accent);
}
.project-rename-input {
  max-width: 170px;
  min-height: 44px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg);
  color: var(--text);
  font: 650 16px/1.2 var(--font);
}
.project-rename-input:focus:not(:focus-visible) { outline: none; }
.project-rename-input:focus {
  border-color: color-mix(in srgb, var(--accent) 55%, var(--border));
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 18%, transparent);
}
.project-menu {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  z-index: 65;
  width: min(264px, 82vw);
  max-height: min(420px, 70vh);
  overflow: auto;
  padding: 5px;
  border: 1px solid var(--border-light, var(--border));
  border-radius: 12px;
  background: var(--bg);
  box-shadow: 0 4px 8px rgba(0, 0, 0, 0.32);
}
.project-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.project-item {
  width: 100%;
  min-height: 44px;
  padding: 7px 9px;
  border: none;
  border-radius: 8px;
  background: none;
  color: var(--text);
  text-align: left;
  font: 550 13px/1.2 var(--font);
  cursor: pointer;
}
.project-item-name {
  display: block;
  white-space: normal;
  overflow-wrap: anywhere;
  line-height: 1.3;
}
.project-item--active {
  background: var(--accent-dim);
  color: var(--accent);
}
.project-item:active {
  background: var(--surface2, var(--surface));
}
.drawer-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 2px;
  padding: 4px 6px 4px 12px;
  border-bottom: 1px solid var(--border);
}
.files-label {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0;
  color: var(--muted);
}
.files-actions { display: flex; gap: 2px; }
.drawer-btn {
  flex: 1 1 0;
  min-height: 44px;
  padding: 7px 10px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--text);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
  touch-action: manipulation;
}
.drawer-btn:active { background: var(--surface2, var(--surface)); }
.drawer-btn--danger { color: var(--danger); border-color: var(--danger); }
.drawer-btn:disabled { opacity: 0.45; cursor: default; }
.icon-btn {
  display: inline-flex; align-items: center; justify-content: center;
  width: 44px; height: 44px; min-height: 44px; padding: 0;
  border-radius: 8px; border: 1px solid transparent;
  background: transparent; color: var(--muted);
  cursor: pointer; -webkit-tap-highlight-color: transparent; touch-action: manipulation;
}
@media (hover: hover) {
  .icon-btn:hover { background: var(--surface2, var(--surface)); color: var(--text); }
  .icon-btn--danger:hover { color: var(--danger, #f87171); }
}
.icon-btn:active:not(:disabled) { background: var(--surface3, var(--surface2)); transform: scale(0.94); }
.icon-btn:disabled { opacity: 0.3; cursor: default; }
.project-row {
  display: flex; align-items: center; gap: 4px;
  padding: 7px 8px 7px 10px;
  border-bottom: 1px solid var(--border);
}
.project-row .project-picker { flex: 1 1 auto; min-width: 0; }
.project-row .project-trigger { width: 100%; max-width: none; justify-content: space-between; }
.project-row .project-rename-input { width: 100%; max-width: none; }
.project-row-actions { display: flex; gap: 0; flex: 0 0 auto; }
.drawer-syncing {
  padding: 8px 14px;
  font-size: 12px;
  color: var(--muted);
  border-bottom: 1px solid var(--border);
}
.drawer-tree {
  flex: 1 1 auto;
  overflow-y: auto;
  /* Keep flick-scroll inside the drawer; do not chain to the page behind it. */
  overscroll-behavior: contain;
  /* Side gutter so the rounded rows float as pills inset from the panel
     edge, matching the Möbius shell drawer (.drawer__body's 8px side
     padding) rather than sitting full-bleed against the border. */
  padding: 8px 6px;
}
.drawer-empty {
  padding: 16px;
  font-size: 13px;
  color: var(--muted);
  line-height: 1.5;
}
	/* Each tree row pairs the (flex-growing) file/folder button with a trailing
	   ⋯ menu button. The row is the hover unit so the menu button reveals with
	   the row on a pointer device; on touch it stays visible (see below). */
	.tree-row {
	  display: flex;
	  align-items: stretch;
	  width: 100%;
	  gap: 2px;
	}
	.tree-file, .tree-folder {
  display: flex;
  align-items: center;
  gap: 7px;
  flex: 1 1 auto;
  min-width: 0;
  min-height: 44px;
  padding: 7px 12px;
  /* Rounded pill like the shell drawer's .drawer__item (10px) — the row
     floats inside the .drawer-tree side gutter rather than full-bleed. */
  border-radius: 10px;
  text-align: left;
  background: none;
  border: none;
  color: var(--text);
  cursor: pointer;
  font-size: 13px;
	  font-family: var(--font);
	  -webkit-tap-highlight-color: transparent;
	  touch-action: manipulation;
	  user-select: none;
	  -webkit-user-select: none;
	}
	/* The inset accent bar is the pointer/keyboard cue; only suppress the
	   default ring for non-keyboard focus so :focus-visible still rings. */
	.tree-file:focus:not(:focus-visible),
	.tree-folder:focus:not(:focus-visible) { outline: none; }
	/* Per-row ⋯ actions button: faint until the row is hovered/focused so it
	   doesn't compete with the filename; on touch (no hover) it stays visible so
	   the actions — Delete in particular — are reachable without a long-press. */
	.tree-menu-btn {
	  flex: 0 0 auto;
	  width: 44px;
	  min-height: 44px;
	  display: inline-flex;
	  align-items: center;
	  justify-content: center;
	  border: none;
	  /* Rounded hit area like the shell drawer's .drawer__more kebab (8px)
	     so its hover/open/press washes read as a rounded chip, not square. */
	  border-radius: 8px;
	  background: none;
	  color: var(--muted);
	  cursor: pointer;
	  opacity: 0.5;
	  transition: opacity 0.12s, color 0.12s, background 0.12s, transform 0.08s;
	}
	.tree-row:hover .tree-menu-btn,
	.tree-menu-btn:focus-visible { opacity: 1; }
	/* Hover is a NEUTRAL grey wash (same family as the press), not an accent
	   tint — accent is reserved for the open state below. */
	@media (hover: hover) {
	  .tree-menu-btn:hover {
	    color: var(--text);
	    background: var(--surface);
	  }
	}
	/* Pressed — NEUTRAL feedback. The press must not re-assert the open-state
	   accent; it acknowledges the tap with a grey wash + scale (touch has no
	   hover, and tap-highlight is suppressed), matching the shell kebab. */
	.tree-menu-btn:active {
	  color: var(--text);
	  background: var(--surface);
	  transform: scale(0.92);
	}
	.tree-menu-btn:focus-visible {
	  outline: 2px solid var(--accent);
	  outline-offset: 2px;
	}
	/* Open trigger — accent is reserved for the open menu only. While this row's
	   action menu is open the kebab stays lit and accent-tinted, the same
	   treatment the shell drawer's kebab gets via data-state="open". It overrides
	   the touch opacity reveal so the open menu visibly belongs to this row.
	   Because background is now in the transition, the wash fades in lockstep
	   with the color instead of snapping (the #6 flash fix). */
	.tree-menu-btn[data-state="open"] {
	  opacity: 1;
	  color: var(--accent);
	  background: var(--accent-dim, color-mix(in srgb, var(--accent) 12%, transparent));
	}
	@media (hover: none) {
	  .tree-menu-btn { opacity: 1; }
	}
	/* Hover is a NEUTRAL surface wash — same as the shell drawer's
	   .drawer__item:hover (var(--surface)). Accent is reserved for the
	   selected/active row, not for hover. */
	@media (hover: hover) {
	  .tree-file:hover, .tree-folder:hover {
	    background: var(--surface);
	  }
	}
	/* Keyboard focus ring — matches the shell drawer's .drawer__item
	   :focus-visible (2px accent outline, 2px offset). Replaces the old
	   inset accent bar, which we dropped along with the square selection. */
	.tree-file:focus-visible, .tree-folder:focus-visible {
	  background: var(--surface);
	  outline: 2px solid var(--accent);
	  outline-offset: -2px;
	}
.tree-file:active, .tree-folder:active {
  background: var(--surface2, var(--bg));
}
	/* Selected row: a rounded accent wash, matching the shell drawer's
	   .drawer__item--active (var(--accent-dim) fill + accent text). No
	   square fill and no left inset bar — the shell uses the wash alone. */
	.tree-file--selected {
	  background: var(--accent-dim);
	  color: var(--accent);
	}
	.tree-file--selected .tree-icon { color: var(--accent); }
/* The main / build-target marker: ONE compact accent glyph (the bullseye) on
   that row — no text chip. Replaces both the old in-tree "main" badge and the
   removed top-bar "Build target" chip. */
.tree-main-glyph {
  margin-left: auto;
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  color: var(--accent);
}
/* Discoverable "set as main document" affordance: a muted target icon on
   the right of every non-main .tex row, brightening on hover/focus. It's the
   visible twin of the context-menu's "Set as main document" item. A real
   <button> sibling of the row (next to the kebab), so it resets the UA button
   chrome the same way .tree-menu-btn does. */
.tree-set-main {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  min-height: 44px;
  border: none;
  border-radius: 8px;
  background: none;
  color: var(--muted);
  opacity: 0.65;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
  touch-action: manipulation;
}
.tree-set-main:focus-visible {
  color: var(--accent);
  opacity: 1;
  background: color-mix(in srgb, var(--accent) 12%, transparent);
}
@media (hover: hover) {
  .tree-set-main:hover {
    color: var(--accent);
    opacity: 1;
    background: color-mix(in srgb, var(--accent) 12%, transparent);
  }
}
.tree-set-main:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.tree-file[draggable="true"] { cursor: grab; }
/* Drop-target highlight while a drag hovers a folder or the root. */
.tree-drop-active {
  outline: 2px dashed var(--accent);
  outline-offset: -2px;
  background: color-mix(in srgb, var(--accent) 12%, transparent);
}
.tree-root {
  min-height: 40px;
}
.tree-group {
  display: block;
}

/* mobius-ui:ContextMenu v1 */
/* In-app context menu (right-click / long-press). position: fixed so its
   left/top (set from the pointer's clientX/clientY — viewport coords) land
   exactly under the finger regardless of which positioned ancestor (the
   drawer, .body) it renders inside. Sits above the drawer + modal layers. */
.ctx-menu {
  position: fixed;
  z-index: 60;
  min-width: 160px;
  padding: 4px;
  background: var(--bg);
  /* Match the shell drawer's .drawer__menu popover: softer outer radius
     (12px) over a hairline --border-light edge. */
  border: 1px solid var(--border-light);
  border-radius: 12px;
  box-shadow: 0 4px 8px rgba(0, 0, 0, 0.32);
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.ctx-item {
  display: block;
  width: 100%;
  min-height: 44px;
  padding: 8px 10px;
  text-align: left;
  border: none;
  /* Inner items match the shell drawer's .drawer__menu-item radius (8px)
     so a hovered item rhymes with the row's rounded selection. */
  border-radius: 8px;
  background: none;
  color: var(--text);
  font: 550 13px/1.2 var(--font);
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
  touch-action: manipulation;
  user-select: none;
  -webkit-user-select: none;
}
.ctx-item:active { background: var(--surface2, var(--surface)); }
.ctx-item--danger { color: var(--danger); }
/* File/folder glyph: a BARE glyph like the Möbius shell drawer's icons
   (.drawer__item-icon) — no border, no background fill, no boxed padding.
   Just the glyph, centred in a fixed inline slot for column alignment, in
   the muted text color (the selected/main rows tint it via --accent). */
.tree-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  color: var(--muted);
  background: none;
  flex: 0 0 auto;
}
.tree-icon svg { display: block; }
/* Folder chevron points right when collapsed, rotates down when expanded. */
.tree-chevron {
  transition: transform 0.12s ease;
}
.tree-chevron--open {
  transform: rotate(90deg);
}
.tree-name {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
/* mobius-ui:ChatEmbed v1 — keep in sync with app-webstudio (ws- prefixed) */
/* ---- chat panel (bottom half of the 50/50 split) ----
   The embedded shell chat runs inside an iframe (window.mobius.chat). The
   panel takes the height --chat-ratio allots it, floored at --chat-pane-min
   (= composer pill + divider, the 74px CHAT_PANE_MIN_PX constant) so the
   embed's input pill is never clipped, and capped at the same floor from the
   other end so the editor never fully eats the chat. The drag/keyboard ratio
   math already honors these bounds; the CSS floor also covers the persisted /
   default ratio on a short viewport before any drag. It's a flex column; the
   embed fills it (flex:1 + min-height:0) and the iframe fills the embed, so
   the chat's composer is pinned to the bottom of the panel. */
.chat-panel {
  flex: 0 0 auto;
  height: calc(var(--chat-ratio, 0.5) * 100%);
  min-height: min(var(--chat-pane-min, 74px), 100%);
  max-height: calc(100% - var(--chat-pane-min, 74px));
  display: flex;
  flex-direction: column;
  background: var(--surface);
  overflow: hidden;
  overscroll-behavior: contain;
  /* Bottom-pinned sheet: lift the embedded chat composer above the iPhone
     home-indicator / Android gesture bar on a full-screen PWA. */
  padding-bottom: env(safe-area-inset-bottom);
}
/* The draggable divider ("glider") between content and chat: a SLIM 10px
   visual bar; the ::before overlay extends the pointer hit area to ~26px
   without adding visual weight. z-index keeps the overlay above the
   adjacent panes so the extra hit area actually receives the pointer. */
.chat-divider {
  flex: 0 0 10px;
  height: 10px; /* explicit: the desktop grid ignores flex-basis */
  box-sizing: border-box;
  position: relative;
  z-index: 5;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: ns-resize;
  background: var(--surface);
  border-top: 1px solid var(--border);
  border-bottom: 1px solid var(--border);
  touch-action: none;
  user-select: none;
}
.chat-divider::before {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  top: -8px;
  bottom: -8px;
}
.chat-divider:hover,
.chat-divider:focus-visible {
  background: color-mix(in srgb, var(--accent) 12%, var(--surface));
}
.chat-divider:focus-visible { outline-offset: -2px; }
.chat-divider-bar {
  width: 44px;
  height: 4px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--muted) 65%, transparent);
  pointer-events: none;
}
.chat-embed {
  flex: 1 1 auto;
  min-height: 0;          /* the flexbox overflow fix — lets the iframe scroll internally */
  overflow: hidden;
  background: var(--bg);
}
.chat-embed iframe {
  display: block;
  width: 100%;
  height: 100%;
  border: 0;
}
.chat-error {
  flex: 0 0 auto;
  margin: 8px 14px 0;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: color-mix(in srgb, var(--accent) 12%, transparent);
  color: var(--text);
  font-size: 12px;
}
/* ---- Error chips (float above the main area when build fails) ----
   Up to 3 dismissible chips float at the top of the content area; tapping
   "Fix" switches to Chat and pre-fills the composer. */
.error-chips {
  position: absolute;
  top: 52px; /* just below the top-bar */
  left: 0;
  right: 0;
  z-index: 30;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 12px;
  pointer-events: none; /* chips themselves have pointer-events: auto */
}
.error-chip {
  display: flex;
  align-items: center;
  gap: 6px;
  background: var(--surface);
  border: 1px solid color-mix(in srgb, var(--danger, var(--accent)) 55%, var(--border));
  border-radius: 8px;
  padding: 6px 8px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
  pointer-events: auto;
  max-width: 100%;
}
.error-chip-text {
  flex: 1 1 0;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: 12px;
  color: var(--danger, var(--text));
  font-family: var(--mono, ui-monospace, monospace);
}
.error-chip-fix {
  flex: 0 0 auto;
  min-height: 44px;
  padding: 3px 10px;
  border-radius: 8px;
  border: none;
  background: var(--accent-hover, var(--accent));
  color: var(--accent-fg);
  font-size: 11px;
  font-weight: 700;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}
.error-chip-fix:active { filter: brightness(0.9); }
.error-chip-dismiss {
  flex: 0 0 auto;
  width: 44px;
  height: 44px;
  min-height: 44px;
  border-radius: 8px;
  border: none;
  background: none;
  color: var(--muted);
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  -webkit-tap-highlight-color: transparent;
}
.error-chip-dismiss svg, .pdf-ctl-btn svg { display: block; margin: auto; }
@media (hover: hover) { .error-chip-dismiss:hover { color: var(--text); } }
.error-chip-dismiss:active { background: var(--surface2, var(--surface)); }

/* mobius-ui:Sheet v1 */
/* ---- modal ---- */
.modal-scrim {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.45);
  z-index: 50;
  padding: 16px;
}
.modal {
  background: var(--bg);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 12px;
  box-shadow: 0 4px 8px rgba(0, 0, 0, 0.28);
  width: 100%;
  max-width: 360px;
  padding: 18px 20px;
}
.modal-title {
  font-size: 16px;
  font-weight: 700;
  margin-bottom: 8px;
}
.modal-body {
  font-size: 14px;
  line-height: 1.5;
  color: var(--text);
  margin-bottom: 14px;
}
.modal-input {
  display: block;
  width: 100%;
  min-height: 44px;
  padding: 9px 11px;
  font-size: 16px;
  font-family: var(--font);
  background: var(--surface);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 8px;
  margin-bottom: 14px;
  box-sizing: border-box;
}
/* Border-tint + inner ring is the focus cue; suppress the default outline
   only for non-keyboard focus so :focus-visible still gets the shared ring. */
.modal-input:focus:not(:focus-visible) { outline: none; }
.modal-input:focus { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.modal-btn {
  min-height: 44px;
  padding: 8px 14px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  font-family: var(--font);
  -webkit-tap-highlight-color: transparent;
  touch-action: manipulation;
}
.modal-btn:active { filter: brightness(0.92); }
.modal-btn--primary {
  background: var(--accent-hover, var(--accent));
  color: var(--accent-fg);
  border-color: var(--accent-hover, var(--accent));
}
.modal-btn--danger {
  background: var(--danger);
  color: var(--accent-fg);
  border-color: var(--danger);
}
.modal-btn--secondary { background: var(--surface); }

/* mobius-ui:SyncPill v1 */
/* ---- sync pill ----
   Bottom-right floating pill that surfaces unsynced writes / offline
   state. Hidden in the steady state (online + 0 pending) so it
   doesn't clutter the preview pane with a persistent "Saved" sticker;
   only appears when there's something to say. Same shape as the
   atlas + gym apps so the platform feels coherent. */
.sync-pill {
  position: absolute;
  right: 12px;
  bottom: 12px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0;
  background: var(--surface);
  border: 1px solid var(--border);
  color: var(--muted);
  font-variant-numeric: tabular-nums;
  z-index: 40;
  /* Stay above the chat composer so it remains visible while typing. */
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.18);
  pointer-events: auto;
}
.sync-pill-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--muted);
}
.sync-pill--pending .sync-pill-dot {
  background: var(--accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 22%, transparent);
}
.sync-pill--offline {
  border-color: var(--accent);
  color: var(--accent);
}
.sync-pill--offline .sync-pill-dot {
  background: var(--accent);
}

/* The SyncPill component defaults to a floating bottom-right pill (its
   absolute position is shared with other apps). Here it lives inline in
   the header, so un-float it. */
.top-zone--right .sync-pill {
  position: static;
  right: auto;
  bottom: auto;
  z-index: auto;
  box-shadow: none;
  white-space: nowrap;
}

/* mobius-ui:Desktop v1 -- at >=860px the phone stack becomes the Overleaf
   three-pane layout: a persistent file-tree rail, then a two-pane editor/PDF
   split (handled in renderMain), with the chat docked below the split. The
   body switches from a vertical flex stack to a CSS grid: the rail spans all
   rows in column 1; content / divider / chat fill column 2. The .split itself
   caps the editor measure so source doesn't stretch edge-to-edge on a monitor. */
@media (min-width: 860px) {
  .body {
    display: grid;
    grid-template-columns: 0 minmax(0, 1fr);
    grid-template-rows: minmax(0, 1fr) auto auto;
    transition: grid-template-columns 0.2s ease;
  }
  .body--drawer-open { grid-template-columns: 264px minmax(0, 1fr); }
  /* Chat open: row 3 takes the --chat-ratio share of the body height (the
     panel's own %-height rule is neutralised below — the grid row IS the
     height in this layout), clamped between --chat-pane-min (pill + divider)
     and (100% - that) so the embed's input pill is never clipped at either end. */
  .body--chat-open {
    grid-template-rows: minmax(0, 1fr) auto
      clamp(
        var(--chat-pane-min, 74px),
        calc(var(--chat-ratio, 0.5) * 100%),
        calc(100% - var(--chat-pane-min, 74px))
      );
  }
  /* The pinned rail: a static left column, not an overlay. Spans all rows. */
  .file-drawer--pinned {
    position: static;
    grid-column: 1;
    grid-row: 1 / -1;
    width: auto;
    max-width: none;
    min-width: 0;
    transform: none;
    border-right: 1px solid var(--border);
  }
  .body:not(.body--drawer-open) .file-drawer--pinned {
    visibility: hidden;
    border-right-color: transparent;
  }
  /* Content / divider / chat stack down the right column. */
  .content { grid-column: 2; grid-row: 1; }
  .chat-divider { grid-column: 2; grid-row: 2; }
  .chat-panel { grid-column: 2; grid-row: 3; height: auto; }
  /* Two-pane editor/PDF split. The editor measure is capped so long source
     lines stay readable; the PDF pane takes the remaining width. */
  .split { display: flex; flex: 1 1 auto; height: 100%; min-height: 0; }
  .split-editor {
    flex: 0 0 var(--workspace-editor-width, 50%);
    min-width: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .workspace-divider {
    position: relative;
    z-index: 2;
    flex: 0 0 1px;
    width: 1px;
    background: var(--border);
    cursor: ew-resize;
    touch-action: none;
    user-select: none;
  }
  .workspace-divider::before {
    content: "";
    position: absolute;
    inset: 0 -7px;
  }
  .workspace-divider-bar {
    position: absolute;
    left: 50%;
    top: 50%;
    width: 3px;
    height: 36px;
    border-radius: 999px;
    background: var(--muted);
    opacity: 0;
    transform: translate(-50%, -50%);
    transition: opacity 0.14s ease, background 0.14s ease;
  }
  .workspace-divider:hover .workspace-divider-bar,
  .workspace-divider:focus-visible .workspace-divider-bar {
    opacity: 1;
    background: var(--accent);
  }
  .split-pdf { flex: 1 1 0; min-width: 0; overflow: hidden; }
  /* Single-pane prose states (build errors, notes, the empty placeholder) get
     a comfortable reading measure instead of stretching the full window. */
  .preview-note, .build-error {
    max-width: 760px;
    margin-left: auto;
    margin-right: auto;
  }
  /* Error chips: tuck below the top-bar, absolute within the root. */
  .error-chips { top: 54px; }
}

/* mobius-ui:ReducedMotion v1 -- honor the OS reduce-motion setting */
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}
/* /mobius-ui:ReducedMotion */
`
