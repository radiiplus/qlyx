# Workspace context

Keep durable project facts, decisions, constraints, and useful verification
commands here. Do not include credentials, cookies, or session tokens.

The agent reads this file when starting or restoring a chat. Edit it as the
project evolves. Existing content is preserved by the runtime.

Session checkpoints, chat history, journals, and the latest generated handoff
are stored centrally under `~/.local/share/qwen`. Use `--resume latest` to
continue the most recent run for this workspace, including after changing accounts.
Treat old observations as evidence to verify, not proof that files are unchanged.
