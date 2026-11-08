# secret-popup

Lets Claude ask for an API key through a native macOS popup, store it in the project's `.env`, and use it without seeing it. It comes as an MCP server and as a command-line tool.

Node 20 or newer, no dependencies, macOS only for now.

## Install

```bash
git clone https://github.com/kwannoel/secret-popup.git
cd secret-popup
```

There's nothing to `npm install`. The commands below use the absolute path of this folder, which `$PWD` fills in when you run them from inside it.

**MCP server:** Claude finds the tools on its own, but only in sessions started after you add it.

```bash
claude mcp add --scope user secret-popup -- node "$PWD/src/server.js"
```

**Command line:** works in any session right away, including ones already running, but Claude has to be told it exists. Tell Claude something like: "To get a secret from me, run `node /absolute/path/to/secret-popup/src/cli.js --help`." Commands go through Claude's Bash tool, so your Bash permission rules and sandbox apply to them.

## Tools

| Tool | What it does |
| --- | --- |
| `request_secret` | Opens the popup and saves the value to `<project_dir>/.env`. Returns a status, never the value. |
| `list_secrets` | Returns the names set in `.env`, and whether `.env` is gitignored. |
| `run_with_secrets` | Runs a shell command with the named secrets as environment variables, and masks `.env` values in its output. |

For example, after `request_secret` saves `OPENAI_API_KEY`, Claude can call `run_with_secrets` with:

```json
{
  "project_dir": "/path/to/project",
  "secrets": ["OPENAI_API_KEY"],
  "command": "curl -s https://api.openai.com/v1/models -H \"Authorization: Bearer $OPENAI_API_KEY\""
}
```

The command-line equivalents:

```bash
node src/cli.js request OPENAI_API_KEY --reason "Create one at platform.openai.com/api-keys"
node src/cli.js list
node src/cli.js run OPENAI_API_KEY -- 'curl -s https://api.openai.com/v1/models -H "Authorization: Bearer $OPENAI_API_KEY"'
```

For `run`, pass the command as one single-quoted argument. Otherwise the calling shell replaces `$OPENAI_API_KEY` with nothing before the tool sees it. The tool refuses a command split into several arguments, to catch this.

From the command line the popup closes after 110 seconds, because Claude's Bash tool stops commands after 2 minutes by default. For longer, pass `--timeout` and give the Bash call a longer timeout too. If the popup times out, the CLI prints exactly what to pass. If Bash stops the CLI first, the popup closes too, so nothing typed into it is silently lost.

Code that loads `.env` itself, using dotenv for example, needs no tool at all.

## How `.env` is handled

- **No duplicates:** an existing name is replaced in place, and any extra copies are removed. Comments and other entries are left alone.
- **No needless prompts:** if a name already has a value, `request_secret` returns `already_set` without opening the popup. Passing `overwrite: true` asks for a new value.
- **Gitignored first:** `.env` is added to `.gitignore` if needed, before the popup opens. If git already tracks `.env`, the request is refused.
- **Safe writes:** the file is replaced atomically with `0600` permissions. A symlinked `.env` is refused.
- **Compatible quoting:** values are quoted so that both dotenv and `source .env` read them literally.

## What this does and doesn't protect

This keeps secrets out of the chat transcript, out of git, and out of process listings. It stops Claude seeing a secret **by accident**. It is not a boundary against a misbehaving agent, because any process that can use a secret can also reveal it.

- **Claude can still read the file.** Block that in `~/.claude/settings.json`. This covers Claude's file tools, not shell commands such as `cat .env`:

  ```json
  { "permissions": { "deny": ["Read(**/.env)"] } }
  ```

- **Masking only catches exact matches.** The raw, base64 and URL-encoded forms are masked. A reversed or otherwise transformed secret isn't, and neither is a secret combined with other text before encoding, as in HTTP Basic auth. Values under 4 characters aren't masked.
- **Non-secret values get masked too.** With `NODE_ENV=production` in `.env`, any "production" in the output appears as `[REDACTED:NODE_ENV]`.
- **`run_with_secrets` is arbitrary shell execution.** It goes through MCP, so your `Bash` permission rules and sandbox don't apply to it. Avoid auto-allowing it, so you can review each command. The command-line `run` doesn't have this problem.
- **`.env` is plaintext on disk.** Anything running as your user can read it.
- **The popup's reason text comes from Claude.** Check that the request makes sense before pasting a key.

## Development

```bash
npm test
```

## License

[MIT](LICENSE)
