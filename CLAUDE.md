# MUD & STEEL — project instructions

See [AGENTS.md](AGENTS.md) for the project map, commands, and rules of the road. This file adds house rules specific to Claude Code sessions.

## Dev servers: always clean up after yourself

We run many sessions in parallel in this repo, each spinning up its own Vite dev server. Orphaned servers pile up, hold ports, and burn CPU.

- When you start a dev server for verification (via `preview_start` with the `wwi-dev` launch config, or any other means), **stop it before ending the task** — call `preview_stop` with the `serverId` once verification is done.
- Treat the server as scoped to the verification step, not the session: start it, verify, capture your proof (screenshot/logs), then stop it.
- If a `preview_list` shows servers you started earlier in the session that are no longer needed, stop those too.
- Never leave a dev server running "in case it's useful later" — restarting one is cheap; leaked ones are not.
