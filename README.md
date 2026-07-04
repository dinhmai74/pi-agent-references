# pi-agent-references
Warning: this is fully vibe coded with pi, use at your own risk.

Pi package ([pi-package](https://pi.dev/packages)) that injects context from configured repos when you `@mention` them or use aliases in chat like opencode references feature.

## Install

```bash
pi install git:github.com/dinhmai74/pi-agent-references
pi install /path/to/pi-agent-references
```

Project scope (team config in `.pi/settings.json`):

```bash
pi install -l npm:pi-agent-references
```

One-off try:

```bash
pi -e npm:pi-agent-references
```

## Config

Merged: global extends project; project keys override.

| File | Scope |
|------|--------|
| `~/.pi/agent/references.json` | global |
| `<cwd>/.pi/references.json` | project |

See [references.example.json](./references.example.json).

- `path`: local path, `~`, relative to cwd, or `https://github.com/org/repo`
- GitHub repos clone to `~/.pi/agent/reference-cache/github/<org>/<repo>` on first `@mention`
- `aliases`: optional natural-language triggers
- Type `@` in the Pi prompt to autocomplete configured reference keys before submitting.

## Tools / commands

- Tool: `list_references` (status only, no network)
- Command: `/references`

## Tests

From this directory (optional vitest in parent `extensions/` workspace):

```bash
npx vitest run references.test.ts
```
