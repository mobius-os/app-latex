---
name: latex-project
description: Work directly in a first-class Möbius LaTeX Project. Use when PROJECT_TYPE is latex:document or the project context names the LaTeX document type; create and edit source under PROJECT_ROOT and keep the PDF as a project artifact.
---

# LaTeX Project

The Project is the workspace. Edit source files directly under `$PROJECT_ROOT`;
do not modify the installed LaTeX app or its app-scoped storage.

- Keep one clear root document (normally `main.tex`) and use relative includes.
- Put images, bibliography files, and section files inside the Project tree.
- Compile with the Project's **Build as PDF** artifact action after meaningful
  source changes; fix the first concrete build error rather than guessing.
- Never delete or replace unrelated Project files while reorganizing a document.
- Prefer portable LaTeX supported by Tectonic. If a package or font is missing,
  surface the exact dependency instead of silently substituting the document's
  design.
