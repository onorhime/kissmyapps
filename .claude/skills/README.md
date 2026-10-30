# Design skills

Claude Code loads every folder here as a project skill for anyone working in this
repository. They were copied unchanged from their public sources on 2026-10-29 so
that every session, local or in the cloud, designs with the same rules.

| Skill | What it is for | Source | Commit | Licence |
| --- | --- | --- | --- | --- |
| `design-taste-frontend` | Taste Skill v2: art direction and anti-slop house rules for pages and app screens, with a browser inspector | [Leonxlnx/taste-skill](https://github.com/Leonxlnx/taste-skill) | `12af471` | MIT |
| `ui-ux-pro-max` | UI UX Pro Max: searchable styles, palettes, type pairings, UX and chart guidelines | [nextlevelbuilder/ui-ux-pro-max-skill](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill) | `28b3b8d` | MIT |
| `design-system` | Token architecture and component specs, from the UI UX Pro Max family | same as above | `28b3b8d` | MIT |
| `no-ui-slop` | Rules that keep generated UI from looking generic | [uxkin/agent](https://github.com/uxkin/agent) | `693e432` | MIT |
| `build-ui` | Step-by-step workflow for new screens, dashboards, polish and reviews | same as above | `693e432` | MIT |
| `ui-states` | Empty, loading, error, offline and long-content states | same as above | `693e432` | MIT |
| `design-md` | Writes a DESIGN.md from what the project really uses | same as above | `693e432` | MIT |
| `ios-screens` | Native-feeling iPhone screens | same as above | `693e432` | MIT |
| `ui-from-screenshot` | Rebuilds a screenshot or mockup with the project's own components | same as above | `693e432` | MIT |
| `uxkin-research` | Researching real apps and flows (searching needs a UXKIN plan) | same as above | `693e432` | MIT |
| `impeccable` | Design commands for critique, polish and anti-pattern checks | [pbakaus/impeccable](https://github.com/pbakaus/impeccable) | `02523ae` | Apache-2.0 |
| `frontend-design` | Anthropic's frontend design skill | [anthropics/skills](https://github.com/anthropics/skills) | `ca45fc4` | Apache-2.0 |

Notes:

- `impeccable` runs a small engine binary. Its launcher downloads it on first use and
  checks it against `scripts/engine-checksums.txt`.
- `ui-ux-pro-max` runs Python 3 scripts for its searches.
- `design-taste-frontend` runs Node 22 scripts and needs Chrome or Chromium for its
  inspector.
- oxlint skips this folder (see `.oxlintrc.json`), so vendored scripts never fail the
  repository's lint.

To update a skill, copy the folder again from its source and change the commit above.
