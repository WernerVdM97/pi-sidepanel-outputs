# pi-sidepanel-outputs

Interactive file output tracker tab for [pi-sidepanel](../pi-sidepanel). Shows all files modified by the agent during the current session via `write` and `edit` tools, rendered as an always-expanded tree. Keyboard navigable with theme colors. Persists across pi restarts via session replay.

<p align="center"><em>👆 Interactive — use keyboard to scroll through modified files</em></p>

## Keybindings

| Key | Action |
|-----|--------|
| `j` / `↓` | Scroll down |
| `k` / `↑` | Scroll up |
| `g` | Jump to top |
| `G` | Jump to bottom |
| `PgUp` | Page up |
| `PgDn` | Page down |

## Display

Files appear as the agent writes or edits them. Directories are always expanded to show the full path context. Each file shows a tag indicating which tool touched it.

```
 └── src/
     ├── [W] index.ts
     ├── [E] utils.ts
     └── components/
         ├── [W] Button.tsx
         └── [E] Modal.tsx
```

### Color coding

| Element | Color | Meaning |
|---------|-------|---------|
| `[W]` | **green** | File created or overwritten by `write` |
| `[E]` | **yellow** | File edited by `edit` |
| Directory | **orange bold** | Parent directory containing modified files |

Deduplication: if the same file is touched by both `write` and `edit`, the later tool overwrites the tag.

## Session persistence

On `session_start`, the tab replays all `write` and `edit` tool calls from the session history (capped at last 1,000 entries). Paths are displayed relative to the working directory.

## Memory safety

Files list capped at **1,000 entries** with LRU eviction of oldest entries.

## Architecture

```
pi-sidepanel-outputs
  └── index.ts   — flat tree model, rendering, event wiring
```

## License

MIT
