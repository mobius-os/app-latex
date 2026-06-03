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

The build button writes `build/target.txt` and runs the app schedule job. Build status is read from `build/status.json`; completed PDFs are tracked per main document and added to the file index when safe.

### File index

The Möbius storage API has no per-app `ls` endpoint, so the app keeps its own list at `files-index.json` — a flat JSON array of paths under `files/`. The agent is told to update this index whenever it creates or deletes a file; the UI also writes to it whenever you create, delete, upload, move, or build from the drawer/workspace. UI writes reject absolute paths, `.` / `..` segments, duplicate separators, and characters the storage backend rejects.

### Offline

`offline_capable: true`. The app shell, file tree, cached source files, images, PDFs, and local edits go through `window.mobius.storage` when the runtime is present, including binary reads and uploads. The header sync pill surfaces offline and pending-write state. Agent chat and server-side PDF builds still require the network.

### Security

Source files are edited as text, and PDFs render through pdf.js canvases rather than injected HTML. User-entered and uploaded paths are constrained to safe relative paths under `files/`; binary uploads use the Mobius storage runtime when available so they inherit its cache, size checks, and outbox behavior.

## License

MIT — see [LICENSE](LICENSE).
