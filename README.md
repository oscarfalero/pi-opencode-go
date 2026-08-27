# pi-opencode-go

OpenCode Go usage in pi status bar — rolling 5h / weekly / monthly + `/go-usage` + `/go-status` toggle.

Ultra-compact status bar indicator for your [OpenCode Go](https://opencode.ai) subscription, designed for [pi](https://github.com/earendil-works/pi-coding-agent) (the pi coding agent / TUI).

## Install

### From npm via pi

```bash
pi install npm:@oscarfalero/pi-opencode-go
pi install npm:@oscarfalero/pi-opencode-go@0.1.0  # pinned
```

### From git via pi

```bash
pi install git:github.com/oscarfalero/pi-opencode-go
pi install git:github.com/oscarfalero/pi-opencode-go@v0.1.0  # pinned tag
pi install https://github.com/oscarfalero/pi-opencode-go
# local path for development
pi install ./path/to/pi-opencode-go
```

Restart pi after installation (or reload extensions) to activate.

## Usage

### `/go-usage`

Show detailed OpenCode Go usage (Rolling / Weekly / Monthly) as a notification:

```
OpenCode Go usage:
   Rolling:  42% — resets in 2h 15m
   Weekly:   18% — resets in 3d 4h
   Monthly:   7% — resets in 12d 6h

   Toggle compact status with /go-status
```

If the key is not configured you will see a warning. If your current model is not an `opencode-go` model, a hint is appended.

### `/go-status`

Toggle the compact status bar indicator on/off.

- `Go compact: on — fetching…` (when a Go model is active)
- `Go compact: on — will appear when a Go model is selected` (when enabled but non-Go model active)
- `Go compact: off — hidden from status bar` (when disabled)

### Status bar behavior

- **Only when provider configured and Go model active:** the indicator appears only if `opencode-go` is configured (valid `OPENCODE_API_KEY`) **and** the current model provider is `opencode-go` **and** compact is enabled.
- **Pastel yellow:** fixed color `mdHeading` (`#f0c674`) — no conditional warning/error colors.
- **Post-turn refresh:** no polling interval. Refreshes on `turn_end` / `agent_settled` (debounced 800ms) plus `session_start` and `model_select`. Shows `Go …` while fetching, `Go --` on failure with no cache, or `Go 12/34/56%` (rolling/weekly/monthly percents) on success.

Example status bar text: `Go 12/34/56%`

## Requirements

- `pi` coding agent (`@earendil-works/pi-coding-agent`) and `@earendil-works/pi-tui`
- OpenCode Go subscription and API key

Set your API key via `~/.pi/agent/auth.json`:

```json
{
  "opencode-go": {
    "type": "api_key",
    "key": "sk-..."
  }
}
```

Or via environment variable (pi resolves `OPENCODE_API_KEY` for the provider):

```bash
export OPENCODE_API_KEY="..."
```

The extension authenticates with `GET https://opencode.ai/zen/go/v1/usage` using `Authorization: Bearer <OPENCODE_API_KEY>`. It also respects a custom `baseUrl` if your provider is configured with a non-localhost override containing `/zen/go/v1`.

## Configuration

The `/go-status` toggle persists to:

```
~/.pi/agent/opencode-go-usage.json
```

Format:

```json
{
  "visible": true
}
```

- `true` (default) — compact status visible when conditions are met
- `false` — hidden from status bar (still allows `/go-usage` on demand)

You can edit this file manually; it is reloaded on each `session_start`. Delete it to restore defaults.

## Development

```bash
# run pi with this extension loaded from the working directory
pi -e .

# install local build into pi (from inside the repo)
pi install ./.

# after changes, reinstall
pi install ./.
```

No build step required — the extension is plain TypeScript loaded directly. No runtime dependencies; `typebox`, `pi-coding-agent`, and `pi-tui` are peer dependencies.

## License

MIT — see [LICENSE](./LICENSE).

## Security

- Your OpenCode API key is sent **only** to the OpenCode usage endpoint: `https://opencode.ai/zen/go/v1/usage` by default, or a custom provider `baseUrl` that includes `/zen/go/v1`. No other host ever receives it.
- The key is resolved through pi's own auth layer (`modelRegistry`) and is never logged or stored by this extension.
- No telemetry, analytics, or data collection — the only network traffic is the usage query described above.
- The only file this extension writes is its toggle state at `<agent-dir>/opencode-go-usage.json` (e.g. `~/.pi/agent/opencode-go-usage.json`).
- Review the source before installing: [extensions/opencode-go-usage.ts](./extensions/opencode-go-usage.ts) is a single small file.
