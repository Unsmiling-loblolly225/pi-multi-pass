# pi-multi-pass

Multi-subscription extension for [pi](https://github.com/badlogic/pi-mono) -- use multiple OAuth accounts per provider with automatic rate-limit rotation.

## Install

```bash
pi install npm:pi-multi-pass
```

Or via git:

```bash
pi install git:github.com/hjanuschka/pi-multi-pass
```

## Features

- **Multiple subscriptions**: Add extra OAuth accounts for any provider
- **Rotation pools**: Group subscriptions and auto-rotate on rate limits
- **TUI management**: `/subs` and `/pool` commands -- no config files needed
- **Labels**: Tag subscriptions (e.g. "work", "personal")
- **Status tracking**: Token expiry, pool health, auth state

## Quick start

```
/subs add              Pick a provider, add a subscription
/login                 Authenticate the new subscription
/pool create           Group subs into a rotation pool
```

That's it. When one account hits a rate limit, multi-pass automatically switches to the next and retries.

## Commands

### `/subs` -- Subscription management

```
/subs              Open menu
/subs add          Add a new subscription
/subs remove       Remove a subscription
/subs login        Login to a subscription
/subs logout       Logout from a subscription
/subs list         List all subscriptions with auth status
/subs status       Detailed status (token expiry, pool membership)
```

### `/pool` -- Rotation pool management

```
/pool              Open menu
/pool create       Create a pool (pick provider, select members)
/pool list         Show all pools
/pool toggle       Enable/disable a pool
/pool remove       Delete a pool (keeps subscriptions)
/pool status       Member health (logged in, rate limited, cooling down)
```

## How pools work

A pool groups multiple subscriptions of the same provider type for automatic failover:

1. You're using `openai-codex` and hit a rate limit
2. Multi-pass detects the error, marks `openai-codex` as exhausted
3. Switches to `openai-codex-2` (same model ID, different account)
4. Retries your last prompt automatically
5. After a 5-minute cooldown, `openai-codex` becomes available again

```
/subs add          -> openai-codex-2
/subs add          -> openai-codex-3
/pool create       -> "codex-pool" with [openai-codex, openai-codex-2, openai-codex-3]
```

Pool status shows real-time health:

```
/pool status
=== codex-pool (enabled) ===
  openai-codex   -- logged in
  openai-codex-2 -- logged in (rate limited, cooling down)
  openai-codex-3 -- logged in
```

## Supported providers

| Provider key | Service |
|---|---|
| `anthropic` | Claude Pro/Max |
| `openai-codex` | ChatGPT Plus/Pro (Codex) |
| `github-copilot` | GitHub Copilot |
| `google-gemini-cli` | Google Cloud Code Assist |
| `google-antigravity` | Antigravity |

## Environment variable (optional)

For scripting, set `MULTI_SUB` instead of using the TUI:

```bash
export MULTI_SUB="openai-codex:2,anthropic:1"
```

Env entries merge with saved config (no duplicates).

## Config file

`~/.pi/agent/multi-pass.json`:

```json
{
  "subscriptions": [
    { "provider": "openai-codex", "index": 2, "label": "work" },
    { "provider": "openai-codex", "index": 3, "label": "personal" },
    { "provider": "anthropic", "index": 2 }
  ],
  "pools": [
    {
      "name": "codex-pool",
      "baseProvider": "openai-codex",
      "members": ["openai-codex", "openai-codex-2", "openai-codex-3"],
      "enabled": true
    }
  ]
}
```

## How it works

- Each subscription registers a new provider (e.g., `anthropic-2`) with its own OAuth flow
- Models are cloned dynamically via `getModels()` -- new models from pi updates appear automatically
- Pools listen to `agent_end` events, detect rate limit errors, and call `setModel()` + `sendUserMessage()` to retry
- Exhausted members have a 5-minute cooldown before re-entering rotation
- All state persisted to `multi-pass.json`; pool exhaustion state is in-memory only

## License

MIT
