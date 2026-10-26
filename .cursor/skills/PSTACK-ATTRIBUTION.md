# pstack attribution

The skills in these directories are copied from pstack, which is MIT-licensed:

- Source: https://github.com/cursor/plugins/tree/main/pstack
- Commit: 99b609a72323b70204eab407c622f436e858e112
- Copyright (c) 2026 Lauren Tan
- License: the MIT text in `PSTACK-LICENSE`, next to this file

Copied directories:

- `setup-pstack`
- `poteto-mode`
- `create-verification-skill`
- `maintain-verification-skill`
- `correct`
- `show-me-your-work`
- `principle-prove-it-works` (prove-it-works)
- `principle-never-block-on-the-human` (never-block-on-the-human)
- `principle-encode-lessons-in-structure` (encode-lessons-in-structure)
- `principle-sequence-verifiable-units` (sequence-verifiable-units)

Cursor has no repository file that turns on a marketplace plugin for Cloud Agents. A `workspaceOpen` hook can load a plugin path in the desktop app and the CLI, and that hook does not run for Cloud Agents. These copies live under `.cursor/skills/` so an agent in this checkout can read them.
