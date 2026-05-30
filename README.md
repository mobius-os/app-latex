# LaTeX

A math-first LaTeX editor for [Möbius](https://github.com/mobius-os). Describe what you want to write in plain English; an AI sub-agent translates your prose into `.tex` files in app storage while you watch the math render live.

<!-- TODO: docs/screenshot.png after first install. -->

## Install

### Via the App Store (recommended)

Open the **App Store** mini-app in Möbius, search for "LaTeX", tap **Install**.

### Via paste-a-URL

In the App Store, choose **Install from URL** and paste:

```
https://raw.githubusercontent.com/mobius-os/app-latex/main/mobius.json
```

Möbius fetches the manifest, shows you the requested permissions and runtime dependencies (KaTeX + DOMPurify, both loaded from esm.sh on first open), and installs with one tap.

## What you get

Three stacked regions, mobile-first:

- **Preview pane (top)** — renders the currently-selected file.
  - `.tex` → math-aware HTML. Inline `$...$` and display `$$...$$` math both render via [KaTeX](https://katex.org/). `\section{}`, `\subsection{}`, `\textbf{}`, `\emph{}` get basic styling; blank lines become paragraph breaks. This is a **preview**, not a full LaTeX engine — no `latexmk`, no packages, no bibliographies. Math correctness is the bar.
  - `.md` → basic Markdown (headings, bold/italic, code, lists, links).
  - `.png` / `.jpg` / `.svg` → image preview (fetched with bearer auth, blob-URL backed).
  - `.pdf` → native browser viewer in an iframe.
- **File tree (left drawer)** — tap the menu icon to slide it out. Shows everything under `files/`. The **+ New file** and **+ New folder** buttons let you create files yourself, but the more useful path is to just ask the agent.
- **Chat panel (bottom)** — sticky composer + scrolling thread. Type what you want; the sub-agent edits files in your app storage and replies with a one-line summary of what it changed. The preview refreshes automatically after each turn.

## How it works

The chat panel POSTs to `/api/chats/<id>/messages` — the same endpoint the main Möbius chat uses. On first send the app creates a dedicated chat and primes it with a short brief telling the sub-agent its working directory (`/data/apps/<your-app-id>/files/`) and the file-index convention (see below). The chat id is persisted to `chat_id.json` so the conversation survives reloads.

While the agent is working, the app polls the chat detail endpoint every two seconds for new replies and the file index every five seconds for new files. As soon as the chat reports idle, the currently-selected file is re-fetched so an edit shows up immediately.

### File index

The Möbius storage API has no per-app `ls` endpoint, so the app keeps its own list at `files-index.json` — a flat JSON array of paths under `files/`. The agent is told to update this index whenever it creates or deletes a file; the UI also writes to it whenever you create or delete from the drawer. If the index ever falls out of sync with reality, just create a new file from the drawer — the index is rewritten in full on each change.

### Offline

`offline_capable: true`. The editor, the preview pane, and the file tree all keep working without a network — you can browse, read, and create files. Only the chat composer is disabled offline (it shows a small notice). There is no outbox; drafts you type while offline are not sent automatically when you come back online.

### Security

The two surfaces that use `dangerouslySetInnerHTML` (the .tex paragraph renderer and the markdown renderer) both pass their HTML through DOMPurify with a strict profile (no `<script>`, `<style>`, `<iframe>`, inline event handlers, or non-`http(s)` URIs). The HTML is built entirely on-device from user-owned local files, but DOMPurify is cheap defense-in-depth against a poisoned file landing on disk via the agent.

## License

MIT — see [LICENSE](LICENSE).
