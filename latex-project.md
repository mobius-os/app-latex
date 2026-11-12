---
name: latex-project
description: Build or edit a LaTeX document when the LaTeX app is installed. In a latex:document Project, edit PROJECT_ROOT and rebuild its PDF artifact. In an ordinary chat with no Project, compile LaTeX directly into a standalone Page while retaining source metadata so the owner can later manage the existing source in Projects.
---

# LaTeX work

## Ordinary chat: a standalone document

When there is no `$PROJECT_ROOT`, do not create a Project merely to produce the
document.

1. Read the `pages` skill to resolve the installed Pages app and mint a
   stable `artifact_id`. Author `.tex` source and related local files directly
   in `/data/apps/<PAGES_APP_ID>/sources/<artifact_id>/`. Keep one clear root
   document, normally `main.tex`; this is the durable editable source tree.
2. Compile it with Tectonic into a separate build directory and fix the first
   concrete error. Keep generated PDF/log files out of the editable tree.
3. Create a standalone self-contained HTML Page presenting the compiled PDF
   from an inline `data:` URL. Publish it as an immutable Page version using
   `pages`; it remains independently openable without a Project.
4. Add explicit builder provenance so Projects can manage the existing source:

```json
{
  "project_import": {
    "template_id": "latex:document",
    "files": [
      {"storage_path": "sources/<artifact_id>/main.tex", "path": "main.tex"}
    ]
  }
}
```

List every source file needed to rebuild the document; never include generated
PDF/log files. Write source files before atomically publishing the record. The
owner can later choose **Add to Projects** to manage this same source tree,
not an independent copy. A project linked this way appears under **Projects**
only. The LaTeX app's own document list deliberately shows just documents
created in the app, so tell the owner to look in Projects and do not call the
exclusion a bug. If they want the document inside the LaTeX app itself, create
it there (**New document**) and build its PDF artifact instead. For later
edits, reuse the source tree and page id,
preserve this metadata, and compile a new immutable preview version. If already
managed by Projects, use that same Project's root and build workflow rather
than making a second editable workspace. Existing Page versions stay unchanged.
Agent-led work and collaboration do not require the Projects interface; public
sharing and Git actions still require the owner's explicit approval.

## Inside a Project

The Project is the workspace. Edit source files directly under `$PROJECT_ROOT`;
do not modify the installed LaTeX app or its app-scoped storage.

- Keep one clear root document (normally `main.tex`) and use relative includes.
- Put images, bibliography files, and section files inside the Project tree.
- Compile with the Project's PDF artifact (**Build** on the artifact row, or
  **Build as PDF** on a file) after meaningful source changes; fix the first
  concrete build error rather than guessing. The built artifact opens in its
  own viewer, independent of the project workspace.
- From a chat, rebuild through the Project's build route instead of running
  `project-builder.sh` yourself:
  `mapi -f -X POST /api/projects/$PROJECT_ID/artifacts/<artifact_id>/build`.
  List the artifact ids with `mapi -f /api/projects/$PROJECT_ID/artifacts`; read
  the build log at `.../<artifact_id>/log`. The platform writes the output to
  `artifacts/<artifact_id>/output/`, the only place the viewer reads.
- Never delete or replace unrelated Project files while reorganizing a document.
- Prefer portable LaTeX supported by Tectonic. If a package or font is missing,
  surface the exact dependency instead of silently substituting the document's
  design.
