# LaTeX

A math-first LaTeX editor for [Möbius](https://github.com/mobius-os). Describe what you want to write in plain English; an AI sub-agent translates your prose into `.tex` files in app storage, and the app gives you an Overleaf-style Source/PDF workspace with an in-app pdf.js viewer.

<!-- TODO: docs/screenshot.png after first install. -->

## Install

### Via the App Store (recommended)

Open the **App Store** mini-app in Möbius, search for "LaTeX", tap **Install**.

### Via paste-a-URL

In the App Store, choose **Install from URL** and paste:

```
https://raw.githubusercontent.com/mobius-os/app-latex/main/mobius.json
```

Möbius fetches the manifest, shows you the requested permissions and runtime dependencies, and installs with one tap.

## What you get

Three working regions, mobile-first:

- **Source/PDF workspace** — edit the selected source file directly, build the main `.tex` document, then inspect the compiled PDF without leaving the app. Images and PDFs opened from the file tree render through authenticated blob reads.
- **File tree (left drawer)** — tap the menu icon to slide it out. Shows everything under `files/`. The drawer supports new files, new folders, uploads, drag-to-move, rename, delete, and setting the main document.
- **Chat panel (bottom)** — type what you want; the sub-agent edits files in your app storage and replies with a one-line summary of what it changed. The current file and file index refresh after chat turns.

## How it works

The chat panel creates a dedicated app chat and primes it with a short brief telling the sub-agent its working directory (`/data/apps/<your-app-id>/files/`), the file-index convention (see below), and the current main-document convention. The chat id is persisted to `chat_id.json` so the conversation survives reloads.

The build button writes a per-run target at `build/runs/<run-id>.target.txt`, records the latest run id in `build/run-id.txt`, and runs the app schedule job. The app polls `build/runs/<run-id>.json`; `build/status.json` is still written as a latest-build convenience for older readers. Completed PDFs are tracked per main document and added to the file index when safe.

## Source layout

- `index.jsx` owns top-level React state, project/file orchestration, build/chat wiring, and signal hooks.
- `domain.js` holds pure path, project, PDF, and cache helpers.
- `storage.js` wraps `window.mobius.storage`, including typed JSON/text/blob reads and project-prefix handling.
- `build/useBuild.js` owns the client-side source-to-PDF state machine.
- `build.sh` is the server-side Tectonic job.
- `theme.js`, `pdf/zoom.js`, and `ui/` contain styling, PDF zoom math, and focused UI components.
- `tests/` uses Node's built-in test runner.

### Data contracts

- `files-index.json` is a typed JSON array of safe paths under `files/`. The agent is told to update this index whenever it creates or deletes a file; the UI also writes to it whenever you create, delete, upload, move, or build from the drawer/workspace. UI writes reject absolute paths, `.` / `..` segments, duplicate separators, and characters the storage backend rejects.
- User files under `files/` are project assets. Text assets, including `files/**/*.json`, are stored as text so they can be edited like LaTeX source; binary assets are stored as blobs.
- App-owned JSON records such as `main.json`, `chat_id.json`, `projects.json`, `build/status.json`, and `build/runs/*.json` use typed JSON storage.

### Offline

`offline_capable: true`. The app shell, file tree, cached source files, images, PDFs, and local edits go through `window.mobius.storage` when the runtime is present, including binary reads and uploads. The header sync pill is silent online and shows a plain `Offline` state when disconnected. Agent chat and server-side PDF builds still require the network.

### Security

Source files are edited as text, and PDFs render through pdf.js canvases rather than injected HTML. User-entered and uploaded paths are constrained to safe relative paths under `files/`; binary uploads use the Mobius storage runtime when available so they inherit its cache, size checks, and outbox behavior.

## License

MIT — see [LICENSE](LICENSE).
