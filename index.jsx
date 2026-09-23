/* A focused project launcher: resume work first, with creation owned by Projects. */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { ChevronRight, FileDocument, FileCode, FilePresentation, Grid, WebsiteNetwork, Plus, Search } from '@openai/apps-sdk-ui/components/Icon'

const LOCAL_TEMPLATE_ID = 'document'
const TYPES = {
  website: { label: 'Website', icon: WebsiteNetwork },
  'mini-app': { label: 'Mini-app', icon: FileCode },
  visualization: { label: 'Visualization', icon: Grid },
  document: { label: 'PDF', icon: FileDocument },
  spreadsheet: { label: 'Spreadsheet', icon: Grid },
  presentation: { label: 'Presentation', icon: FilePresentation },
}
const CSS = `
* { box-sizing: border-box; }
body { margin: 0; }
.lpx-root { min-height: 100%; color: var(--text); background: var(--bg); font-family: var(--font); }
.lpx-shell { width: min(820px, 100%); margin: 0 auto; padding: 24px clamp(16px, 4vw, 36px) max(28px, env(safe-area-inset-bottom)); }
.lpx-header { display: flex; align-items: center; gap: 16px; }
.lpx-logo { width: 56px; height: 56px; object-fit: contain; flex: 0 0 auto; }
.lpx-header h1 { margin: 0; font-size: 28px; font-weight: 650; letter-spacing: -.03em; }
.lpx-description { margin: 8px 0 0; max-width: 52ch; font-size: 14px; line-height: 1.5; color: var(--muted); }
.lpx-primary { min-height: 44px; display: inline-flex; align-items: center; justify-content: center; gap: 8px; padding: 0 16px; border: 0; border-radius: 10px; color: var(--accent-fg, white); background: var(--accent); font: inherit; font-size: 14px; font-weight: 600; cursor: pointer; }
.lpx-create { margin: 24px 0 28px; }
.lpx-section { border-top: 1px solid var(--border); padding-top: 12px; }
.lpx-section-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.lpx-section-head h2 { margin: 0; font-size: 16px; font-weight: 600; }
.lpx-secondary { min-height: 44px; padding: 0 8px; border: 0; background: transparent; color: var(--muted); font: inherit; font-size: 13px; cursor: pointer; }
.lpx-secondary:hover { color: var(--text); background: var(--surface); border-radius: 8px; }
.lpx-search { display: flex; gap: 10px; align-items: center; min-height: 44px; padding: 0 12px; margin: 10px 0 12px; border: 1px solid var(--border); border-radius: 10px; color: var(--muted); background: var(--surface); }
.lpx-search input { width: 100%; min-width: 0; min-height: 44px; padding: 0; border: 0; outline: 0; background: transparent; color: var(--text); font: inherit; font-size: 14px; }
.lpx-search:focus-within { outline: 2px solid var(--accent); outline-offset: 2px; }
.lpx-search input::placeholder { color: var(--muted); }
.lpx-list { display: grid; gap: 4px; }
.lpx-project { width: 100%; min-height: 60px; display: flex; align-items: center; gap: 12px; padding: 8px; border: 0; border-radius: 10px; color: var(--text); background: transparent; font: inherit; text-align: left; cursor: pointer; }
.lpx-project:hover { background: var(--surface); }
.lpx-project-icon { width: 36px; height: 36px; flex: 0 0 auto; display: grid; place-items: center; border: 1px solid color-mix(in srgb, var(--project-row-accent, var(--text)) 25%, var(--border)); border-radius: 10px; color: var(--project-row-accent, var(--text)); background: var(--surface); }
.lpx-project-copy { min-width: 0; flex: 1; display: grid; gap: 4px; }
.lpx-project-copy strong { font-size: 14px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lpx-project-copy small { font-size: 12px; color: var(--muted); }
.lpx-project > svg { color: var(--muted); flex-shrink: 0; }
.lpx-empty { padding: 28px 8px; color: var(--muted); font-size: 14px; line-height: 1.5; }
.lpx-empty p { margin: 0 0 8px; }
.lpx-error { color: var(--danger); font-size: 14px; line-height: 1.5; }
.lpx-error p { margin: 8px 0; }
.lpx-footer { margin-top: 20px; }
.lpx-primary:focus-visible, .lpx-secondary:focus-visible, .lpx-project:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.lpx-root button:disabled { cursor: default; opacity: .55; }
.lpx-root ::selection { color: var(--text); background: var(--accent-dim, var(--surface)); }
@media (max-width: 520px) {
  .lpx-shell { padding-top: 20px; }
  .lpx-header { align-items: flex-start; gap: 12px; }
  .lpx-logo { width: 48px; height: 48px; }
  .lpx-header h1 { font-size: 25px; }
  .lpx-primary { width: 100%; }
}
`

export default function App({ appId }) {
  const projectApi = window.mobius?.projects
  const [projects, setProjects] = useState([])
  const [templates, setTemplates] = useState([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')

  const refresh = useCallback(async () => {
    if (!projectApi?.templates) { setLoadError('Refresh Möbius to load Projects support.'); setLoading(false); return }
    setLoading(true)
    setLoadError('')
    try {
      const [rows, types] = await Promise.all([
        projectApi.list(),
        projectApi.templates(),
      ])
      setProjects(rows)
      setTemplates(types)
      window.mobius?.signal?.('app_ready', { item_count: rows.length })
    } catch (cause) {
      setLoadError(window.mobius?.online === false
        ? 'LaTeX needs a connection to load Projects. It will retry when you reconnect.'
        : (cause?.message || 'Could not load your projects. Try again.'))
    } finally { setLoading(false) }
  }, [projectApi])
  useEffect(() => {
    void refresh()
    let initial = true
    const detach = window.mobius?.onOnlineChange?.((online) => {
      if (initial) { initial = false; return }
      if (online) void refresh()
    })
    return () => { if (typeof detach === 'function') detach() }
  }, [refresh])

  async function createProject() {
    const template = templates.find(row => row.id === LOCAL_TEMPLATE_ID)
    if (!template || creating) return
    setCreating(true); setError('')
    try {
      await projectApi.create({ templateId: template.key, name: 'Untitled document' })
      window.mobius?.signal?.('item_created', { type: 'document' })
    } catch (cause) { setError(cause?.message || 'Could not create your document. Try again.') }
    finally { setCreating(false) }
  }
  async function openProject(id) {
    setError('')
    try { await projectApi.open(id) }
    catch (cause) { setError(cause?.message || 'Could not open this project. Refresh the list and try again.') }
  }
  async function browse() {
    setError('')
    try { await projectApi.browse() }
    catch (cause) { setError(cause?.message || 'Could not open Projects. Try again.') }
  }
  const rows = useMemo(() => [...projects].sort((a, b) => new Date(b.updated_at || 0) - new Date(a.updated_at || 0))
    .filter(row => row.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())), [projects, search])
  const canCreate = templates.some(row => row.id === LOCAL_TEMPLATE_ID)
  return (
    <main className="lpx-root">
      <style>{CSS}</style>
      <div className="lpx-shell">
        <header className="lpx-header">
          <img className="lpx-logo" src={`/api/apps/${appId}/icon`} alt="" />
          <div><h1>LaTeX</h1><p className="lpx-description">Write with project chats, keep your source together, and build a PDF.</p></div>
        </header>
        <div className="lpx-create">
          <button type="button" className="lpx-primary" disabled={creating || !canCreate} onClick={() => void createProject()}><Plus width={18} height={18} aria-hidden="true" />{creating ? 'Creating…' : 'New document'}</button>
          {!loading && !loadError && !canCreate && <p className="lpx-error" role="alert">This project type is unavailable. Refresh the list or check the app installation.</p>}
        </div>
        {error && <p className="lpx-error" role="alert">{error}</p>}
        <section className="lpx-section" aria-labelledby="lpx-projects-title">
          <header className="lpx-section-head"><h2 id="lpx-projects-title">Your projects</h2><button type="button" className="lpx-secondary" disabled={loading} onClick={() => void refresh()}>{loading ? 'Refreshing…' : 'Refresh'}</button></header>
          {loadError && <div className="lpx-error" role="alert"><p>{loadError}</p><button type="button" className="lpx-secondary" onClick={() => void refresh()}>Try again</button></div>}
          {projects.length > 0 && <label className="lpx-search"><Search width={18} height={18} aria-hidden="true" /><input type="search" aria-label="Find a project" placeholder="Find a project" value={search} onChange={event => setSearch(event.target.value)} /></label>}
          {loading && projects.length === 0 ? <p className="lpx-empty" role="status">Loading your projects…</p>
            : !loadError && projects.length === 0 ? <div className="lpx-empty"><p>Your document projects will appear here.</p><p>Start one above, then use its chat to describe what you want to make.</p></div>
            : rows.length === 0 && projects.length > 0 ? <div className="lpx-empty"><p>No projects match “{search}”.</p><button className="lpx-secondary" onClick={() => setSearch('')}>Clear search</button></div>
            : <div className="lpx-list">{rows.map(project => {
              const type = TYPES[project.template?.id] || { label: 'Project', icon: FileDocument }
              const Icon = type.icon
              const date = new Date(project.updated_at || '')
              return <button type="button" className="lpx-project" key={project.id} onClick={() => void openProject(project.id)}>
                <span className="lpx-project-icon" aria-hidden="true" style={{ '--project-row-accent': /^#[0-9a-f]{6}$/i.test(project.color || '') ? project.color : 'var(--text)' }}><Icon width={18} height={18} /></span>
                <span className="lpx-project-copy"><strong>{project.name}</strong><small>{type.label}{!Number.isNaN(date.getTime()) && ` · ${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`}</small></span>
                <ChevronRight width={16} height={16} aria-hidden="true" />
              </button>
            })}</div>}
        </section>
        <footer className="lpx-footer"><button type="button" className="lpx-secondary" onClick={() => void browse()}>All Projects & project types <ChevronRight width={14} height={14} aria-hidden="true" /></button></footer>
      </div>
    </main>
  )
}
