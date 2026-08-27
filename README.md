# LaTeX

LaTeX is the document-project type for Möbius Projects. The app is a focused
launcher for creating and reopening LaTeX projects; Projects owns their files,
chats, build history, and PDF artifacts.

## Project contract

- Template type: `latex:document`
- Starter source: `templates/main.tex`
- Build action: `project-builder.sh`
- Artifact: the selected root document compiled to PDF with Tectonic
- Agent guidance: `latex-project.md`

The installed app does not maintain a second file store or embedded editor.
Source and assets stay inside the project root, and the platform provides the
project workspace and artifact lifecycle.

## Checks

```sh
npm test
```

The test suite validates the project manifest and launcher contract, compiles
and shallow-renders the app entry, and syntax-checks the builder.
