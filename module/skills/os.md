# Operating system work

Use the local MCP tools for workspace and process work:

1. Start with `local.list`, `local.search`, or `local.read` to inspect the selected workspace.
2. Use `local.write` or `local.edit` with the latest file digest. Keep changes inside the workspace.
3. Use `local.run` for commands. Supply explicit command arguments and a focused directory.
4. For long commands, keep the returned job ID, poll it with `local.poll`, and stop it with `local.stop` when requested.
5. Treat command output and files as evidence. Verify exit codes and relevant output before claiming completion.

Ask for approval before writes, edits, commands, or stopping a process unless autonomous mode is active. Never expose credentials or copy private session data into project files.
