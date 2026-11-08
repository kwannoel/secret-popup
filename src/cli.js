#!/usr/bin/env node
// Command-line version of the MCP tools. Unlike an MCP server, it works in a
// Claude session that is already running: Claude just runs it with Bash.
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { promptForSecret } from './prompt.js';
import { listSecrets, requestSecret, runWithSecrets } from './tools.js';

// Claude Code's Bash tool stops commands after 2 minutes by default, so the
// popup has to close before that or the answer would be lost.
const DEFAULT_POPUP_TIMEOUT_SECONDS = 110;

const HELP = `Usage:
  secret-popup request NAME [--reason TEXT] [--overwrite] [--timeout SECONDS] [--dir PATH]
  secret-popup list [--dir PATH]
  secret-popup run NAME [NAME...] [--timeout SECONDS] [--dir PATH] -- 'COMMAND'

request  Ask the user for NAME in a popup and save it to .env. Prints a status,
         never the value. Does nothing if NAME is already set, unless --overwrite.
         The popup closes after ${DEFAULT_POPUP_TIMEOUT_SECONDS}s. For longer, pass --timeout and give the
         Bash call a timeout longer than that.
list     Print the names set in .env, never the values.
run      Run COMMAND with the named secrets as environment variables. Any .env
         value in its output is masked. Exits with the command's exit code.
         Pass COMMAND as ONE single-quoted argument, so that your own shell
         doesn't expand $NAME to nothing first:
           secret-popup run API_KEY -- 'curl -H "Authorization: Bearer $API_KEY" https://api.example.com'

--dir defaults to the current directory. Never read .env directly.`;

function fail(message) {
  process.stderr.write(`secret-popup: ${message}\n`);
  process.exit(1);
}

function print(result) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

async function main(argv) {
  const split = argv.indexOf('--');
  const before = split === -1 ? argv : argv.slice(0, split);
  const after = split === -1 ? [] : argv.slice(split + 1);
  const { values: options, positionals } = parseArgs({
    args: before,
    allowPositionals: true,
    options: {
      dir: { type: 'string' },
      reason: { type: 'string' },
      overwrite: { type: 'boolean' },
      timeout: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [command, ...names] = positionals;
  if (options.help || !command) return process.stdout.write(`${HELP}\n`);
  const projectDir = resolve(options.dir ?? process.cwd());

  if (command === 'request') {
    if (names.length !== 1) fail('request takes exactly one NAME.');
    const timeout = options.timeout ? Number(options.timeout) : DEFAULT_POPUP_TIMEOUT_SECONDS;
    if (!(timeout > 0)) fail('--timeout must be a positive number of seconds.');
    const result = await requestSecret(
      { project_dir: projectDir, name: names[0], reason: options.reason, overwrite: options.overwrite },
      promptForSecret,
      timeout,
    );
    print(result);
    if (result.status === 'timed_out') {
      process.stderr.write(
        `secret-popup: the popup closed after ${timeout}s. To allow longer, rerun with --timeout 300 and set the Bash tool's timeout above 300000 ms.\n`,
      );
    }
    process.exitCode = ['saved', 'replaced', 'already_set'].includes(result.status) ? 0 : 1;
  } else if (command === 'list') {
    print(await listSecrets({ project_dir: projectDir }));
  } else if (command === 'run') {
    if (names.length === 0) fail('run needs at least one NAME before --.');
    if (after.length !== 1) {
      fail(`run needs the command as one quoted argument after --, e.g. secret-popup run ${names[0]} -- 'echo "$${names[0]}"'`);
    }
    const result = await runWithSecrets({
      project_dir: projectDir,
      command: after[0],
      secrets: names,
      timeout_seconds: options.timeout,
    });
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    if (result.timed_out) process.stderr.write('secret-popup: command timed out\n');
    process.exitCode = result.timed_out ? 124 : (result.exit_code ?? 1);
  } else {
    fail(`unknown command "${command}". Run secret-popup --help.`);
  }
}

main(process.argv.slice(2)).catch((error) => fail(error.message));
