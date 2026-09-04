---
name: latex-project
description: Build or edit a LaTeX document when the LaTeX app is installed. In a latex:document Project, edit PROJECT_ROOT and rebuild its PDF artifact. In an ordinary chat with no Project, compile LaTeX directly into a standalone Page while retaining source metadata so the owner can later import an editable Project copy.
---

# LaTeX work

## Ordinary chat: a standalone document

When there is no `$PROJECT_ROOT`, do not create a Project merely to produce the
document.

1. Author the `.tex` source and related local files in a temporary working
   directory. Keep one clear root document, normally `main.tex`.
2. Compile it with Tectonic and fix the first concrete error.
3. Read the `artifacts` skill (the Pages app) and create a standalone
   self-contained HTML Page that presents the compiled PDF from an inline
   `data:` URL. The Page is the pure independently openable result.
4. Also copy the editable inputs into
   `sources/<artifact_id>/` under the Pages app's numeric storage tree.
   Add this record metadata so Projects can recreate an editable document:

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
owner can later choose **Projects → New → Import existing**; importing creates
an independent copy and does not live-link edits back to the Page.

## Inside a Project

The Project is the workspace. Edit source files directly under `$PROJECT_ROOT`;
do not modify the installed LaTeX app or its app-scoped storage.

- Keep one clear root document (normally `main.tex`) and use relative includes.
- Put images, bibliography files, and section files inside the Project tree.
- Compile with the Project's PDF artifact (**Build** on the artifact row, or
  **Build as PDF** on a file) after meaningful source changes; fix the first
  concrete build error rather than guessing. The built artifact opens in its
  own viewer, independent of the project workspace.
- Never delete or replace unrelated Project files while reorganizing a document.
- Prefer portable LaTeX supported by Tectonic. If a package or font is missing,
  surface the exact dependency instead of silently substituting the document's
  design.
