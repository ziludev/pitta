# Security

pitta runs code on your machine with your credentials. Treat it like a shell you gave to a model, because that is what it is.

## The model

- **One process, one storage.** `.data/agent.owner` is created exclusively; a second process refuses to start rather than write the same SQLite file.
- **The bridge is local.** `AGENT_HTTP_HOST` defaults to `127.0.0.1` and the port should never be exposed to a network. Set `AGENT_HTTP_TOKEN` if anything else on the machine can reach it.
- **Every chat has one level**: `closed`, `owner` or `group`. Only `owner` chats get the full tool surface.
- **The guest tool surface is enforced in code**, not in the prompt: `read` (workspace and the conversation's own project, sensitive files refused), `skill`, `recall`, `remind`, `project_search`, `logs_query`. `bash`, `write`, `edit`, `feishu_*`, `mcp__*` and `delegate` are refused before they run.
- **Dangerous calls ask first** (`rm -rf`, force-push, `sudo`, writes outside the workspace, …). The approval card goes to the owner's DM, only ids listed in `FEISHU_ALLOWED_SENDER_IDS` can tap it, and no tap within 10 minutes means denied.
- **`.env` holds real secrets.** It is gitignored; keep it that way, and keep `.data/` and `logs/` out of anything you publish.

## Reporting

Please open a private security advisory on GitHub (Security → Report a vulnerability) rather than a public issue. Include the version (`git rev-parse HEAD`), what an attacker gains, and the smallest reproduction. There is no bug bounty.

## Known limits

- `bash` can in principle `cd` out of the workspace; the guard hook covers danger, it is not a sandbox.
- The guard decides on command text. A determined model plus a creative command is a real risk; run it as a user you would trust with that shell.
