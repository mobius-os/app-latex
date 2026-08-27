import { useCallback, useEffect, useState } from 'react'
import { ChevronRight, FileDocument, Plus } from '@openai/apps-sdk-ui/components/Icon'

const TEMPLATE_ID = 'latex:document'

const CSS = `
* { box-sizing: border-box; }
html, body, #root { min-height: 100%; }
body { margin: 0; }
.lpx-root { min-height: 100%; color: var(--text); background: var(--bg); font-family: var(--font); }
.lpx-shell { width: min(900px, 100%); margin: 0 auto; padding: max(20px, env(safe-area-inset-top)) clamp(16px, 5vw, 44px) max(28px, env(safe-area-inset-bottom)); }
.lpx-hero { display: grid; grid-template-columns: 210px minmax(0, 1fr); align-items: center; gap: clamp(24px, 6vw, 58px); padding: clamp(12px, 3vw, 26px) 0 clamp(28px, 6vw, 48px); }
.lpx-visual { position: relative; min-height: 220px; display: grid; place-items: center; overflow: hidden; border: 1px solid color-mix(in srgb, var(--accent) 18%, var(--border-light, var(--border))); border-radius: 24px; background: color-mix(in srgb, var(--accent) 7%, var(--surface)); }
.lpx-paper { position: absolute; width: 116px; height: 154px; border: 1px solid color-mix(in srgb, var(--accent) 15%, var(--border)); border-radius: 8px; background: var(--bg); box-shadow: 0 14px 40px color-mix(in srgb, var(--accent) 12%, transparent); }
.lpx-paper--back { transform: translate(-17px, 8px) rotate(-7deg); opacity: .72; }
.lpx-paper--front { transform: translate(10px, -4px) rotate(3deg); }
.lpx-paper::before, .lpx-paper::after { content: ''; position: absolute; left: 20px; right: 20px; height: 2px; border-radius: 2px; background: color-mix(in srgb, var(--muted) 22%, transparent); box-shadow: 0 13px 0 color-mix(in srgb, var(--muted) 16%, transparent), 0 26px 0 color-mix(in srgb, var(--muted) 16%, transparent); }
.lpx-paper::before { top: 82px; }
.lpx-paper::after { top: 121px; right: 42px; }
.lpx-logo { position: relative; z-index: 2; width: 88px; height: 88px; object-fit: contain; filter: drop-shadow(0 12px 18px color-mix(in srgb, var(--accent) 20%, transparent)); }
.lpx-copy { min-width: 0; }
.lpx-title { display: flex; align-items: center; gap: 11px; margin: 0; font-size: clamp(28px, 5vw, 42px); line-height: 1; letter-spacing: -.045em; font-weight: 680; }
.lpx-title-logo { display: none; width: 42px; height: 42px; object-fit: contain; }
.lpx-description { max-width: 46ch; margin: 14px 0 22px; color: var(--muted); font-size: 15px; line-height: 1.55; }
.lpx-primary, .lpx-secondary, .lpx-project { min-height: 44px; font: inherit; }
.lpx-primary { display: inline-flex; align-items: center; justify-content: center; gap: 8px; padding: 0 16px; border: 1px solid var(--accent); border-radius: 11px; color: var(--accent-fg, white); background: var(--accent); font-size: 13px; font-weight: 700; cursor: pointer; }
.lpx-primary:disabled { cursor: default; opacity: .55; }
.lpx-section { border-top: 1px solid var(--border-light, var(--border)); padding-top: 18px; }
.lpx-section-head { display: flex; align-items: center; justify-content: space-between; gap: 14px; margin-bottom: 10px; }
.lpx-section-head h2 { margin: 0; font-size: 14px; letter-spacing: -.01em; }
.lpx-secondary { padding: 0 8px; border: 0; color: var(--muted); background: transparent; font-size: 12px; font-weight: 650; cursor: pointer; }
.lpx-secondary:hover { color: var(--text); }
.lpx-list { display: grid; gap: 3px; }
.lpx-project { width: 100%; display: grid; grid-template-columns: 34px minmax(0, 1fr) auto; align-items: center; gap: 10px; padding: 7px 8px; border: 0; border-radius: 10px; color: var(--text); background: transparent; text-align: left; cursor: pointer; }
.lpx-project:hover { background: var(--surface); }
.lpx-project-icon { width: 28px; height: 28px; display: grid; place-items: center; border-radius: 8px; color: var(--accent); background: color-mix(in srgb, var(--accent) 10%, transparent); }
.lpx-project-copy { min-width: 0; display: grid; gap: 2px; }
.lpx-project-copy strong, .lpx-project-copy small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lpx-project-copy strong { font-size: 13px; }
.lpx-project-copy small { color: var(--muted); font-size: 10px; }
.lpx-project > svg { color: var(--muted); }
.lpx-empty { min-height: 126px; display: grid; place-content: center; justify-items: center; gap: 7px; padding: 20px; border: 1px dashed var(--border-light, var(--border)); border-radius: 13px; color: var(--muted); text-align: center; }
.lpx-empty p { margin: 0; font-size: 12px; line-height: 1.45; }
.lpx-error { margin: 0 0 14px; padding: 10px 12px; border: 1px solid color-mix(in srgb, var(--danger, #c43d3d) 28%, var(--border)); border-radius: 10px; color: var(--danger, #c43d3d); background: color-mix(in srgb, var(--danger, #c43d3d) 7%, var(--surface)); font-size: 12px; }
.lpx-primary:focus-visible, .lpx-secondary:focus-visible, .lpx-project:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
@media (max-width: 620px) {
  .lpx-shell { padding-top: max(16px, env(safe-area-inset-top)); }
  .lpx-hero { grid-template-columns: 1fr; gap: 14px; padding-top: 6px; }
  .lpx-visual { min-height: 158px; }
  .lpx-paper { width: 90px; height: 120px; }
  .lpx-paper::before { top: 64px; }
  .lpx-paper::after { top: 92px; }
  .lpx-logo { width: 68px; height: 68px; }
  .lpx-title { font-size: 30px; }
  .lpx-description { margin: 10px 0 17px; font-size: 14px; }
  .lpx-primary { width: 100%; }
}
@media (prefers-reduced-motion: no-preference) {
  .lpx-primary, .lpx-project { transition: transform 140ms ease, background 140ms ease, filter 140ms ease; }
  .lpx-primary:hover { filter: brightness(1.04); transform: translateY(-1px); }
  .lpx-primary:active { transform: none; }
}
`

function projectSubtitle(project) {
  const updated = project?.updated_at ? new Date(project.updated_at) : null
  if (!updated || Number.isNaN(updated.getTime())) return 'LaTeX project'
  return `Updated ${updated.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
}

export default function App({ appId }) {
  const [projects, setProjects] = useState([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState('')
  const projectApi = window.mobius?.projects
  const logoUrl = `/api/apps/${appId}/icon`

  const refresh = useCallback(async ({ migrate = false } = {}) => {
    if (!projectApi) { setError('Projects need a newer Möbius shell.'); setLoading(false); return }
    setError('')
    try {
      const rows = migrate && typeof projectApi.migrate === 'function' ? await projectApi.migrate() : await projectApi.list()
      setProjects(Array.isArray(rows) ? rows : [])
    } catch (cause) { setError(cause?.message || 'Projects are unavailable right now.') }
    finally { setLoading(false) }
  }, [projectApi])

  useEffect(() => { void refresh({ migrate: true }) }, [refresh])

  async function createProject() {
    if (!projectApi || creating) return
    setCreating(true); setError('')
    try {
      const project = await projectApi.create({ templateId: TEMPLATE_ID, name: 'Untitled LaTeX document' })
      if (project?.id) await projectApi.open(project.id)
    } catch (cause) { setError(cause?.message || 'Could not create a LaTeX project.') }
    finally { setCreating(false) }
  }

  return (
    <main className="lpx-root">
      <style>{CSS}</style>
      <div className="lpx-shell">
        <section className="lpx-hero" aria-labelledby="lpx-title">
          <div className="lpx-visual" aria-hidden="true">
            <span className="lpx-paper lpx-paper--back" />
            <span className="lpx-paper lpx-paper--front" />
            <img className="lpx-logo" src={logoUrl} alt="" />
          </div>
          <div className="lpx-copy">
            <h1 className="lpx-title" id="lpx-title">LaTeX</h1>
            <p className="lpx-description">Create document projects, edit source files with project chats, and build PDFs.</p>
            <button type="button" className="lpx-primary" disabled={creating || !projectApi} onClick={() => void createProject()}>
              <Plus size={17} /> {creating ? 'Creating…' : 'New document'}
            </button>
          </div>
        </section>

        {error && <p className="lpx-error" role="alert">{error}</p>}

        <section className="lpx-section" aria-labelledby="lpx-projects-title">
          <div className="lpx-section-head">
            <h2 id="lpx-projects-title">LaTeX projects</h2>
            <button type="button" className="lpx-secondary" disabled={!projectApi} onClick={() => projectApi?.browse()}>View all Projects</button>
          </div>
          {loading ? (
            <div className="lpx-empty" role="status"><p>Loading projects…</p></div>
          ) : projects.length === 0 ? (
            <div className="lpx-empty"><FileDocument size={25} aria-hidden="true" /><p>No LaTeX projects yet.</p></div>
          ) : (
            <div className="lpx-list">
              {projects.map(project => (
                <button key={project.id} type="button" className="lpx-project" onClick={() => projectApi?.open(project.id)}>
                  <span className="lpx-project-icon" aria-hidden="true"><FileDocument size={16} /></span>
                  <span className="lpx-project-copy"><strong>{project.name}</strong><small>{projectSubtitle(project)}</small></span>
                  <ChevronRight size={16} aria-hidden="true" />
                </button>
              ))}
            </div>
          )}
        </section>
      </div>
    </main>
  )
}
