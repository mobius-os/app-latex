export const APP_VERSION = '2.15.4'
export const DEFAULT_PROJECT_ID = 'default'
export const PROJECTS_KEY = 'projects.json'
export const PROJECT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/

// Allowed characters for any storage path the UI writes. NAME_RE mirrors the
// server's `_SAFE_RE` (`[\w.\-/]+`); isSafeRelPath adds browser-side semantic
// guards (`.` / `..`, empty segments, absolute paths) so user input can never
// escape the app's files/ tree before it reaches storage.
export const NAME_RE = /^[\w.\-/]+$/

export const BINARY_FILE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'pdf'])

export const LONG_PRESS_MS = 500
export const LONG_PRESS_SLOP = 10

export const FILE_CONTENT_CACHE_LIMIT = 20
export const FILE_CACHE_VERSION = 1

export const CHAT_OPEN_VERSION = 1
export const CHAT_RATIO_VERSION = 1

// The chat pane must never collapse smaller than the embedded composer's input
// pill — the owner spec is "down to the top of the input pill but not more and
// not less". The embed runs the real ChatView in an opaque iframe and publishes
// no composer-height var, so we floor the pane at the standard Möbius composer
// pill height (~64px) plus the divider (10px). The message list above the pill
// can collapse to zero; the pill itself always stays fully visible and usable.
// The same floor caps the OTHER end so the editor never fully eats the chat.
export const CHAT_PILL_MIN_PX = 64
export const CHAT_DIVIDER_PX = 10
export const CHAT_PANE_MIN_PX = CHAT_PILL_MIN_PX + CHAT_DIVIDER_PX
// Keep both sides of the desktop source/PDF workspace usable while allowing
// either pane to become the focus. The ratio clamp falls back to 50/50 if a
// narrow host cannot honor both floors.
export const WORKSPACE_PANE_MIN_PX = 220

export const BUILD_POLL_MS = 2000
export const BUILD_TIMEOUT_MS = 120000
export const SOURCE_AUTOSAVE_MS = 700
export const SOURCE_SYNC_MS = 3500
export const PROJECT_SYNC_MS = 5000
