# AGENTS.md

## Communication

- Respond in Japanese.

## Docs Workflow

- When the user asks to update "docs" while working from this repository (`~/vault`), treat the target as the separate docs repository at `~/docs`, not files inside `~/vault` unless the user explicitly says otherwise.
- For docs requests, inspect and edit files under `~/docs`.
- After updating `~/docs`, do not stop at local edits. Commit the docs changes and push them to the remote branch that should be published, unless the user explicitly asks not to push.
- If the docs change requires a page rename or navigation update, update the relevant table of contents or summary files in `~/docs` as part of the same task.
- Keep code changes in `~/vault` and docs changes in `~/docs` separated. Do not mix unrelated changes across the two repositories.

## Existing Local Rules

- Also follow the project-specific guidance in `CLAUDE.md`.
