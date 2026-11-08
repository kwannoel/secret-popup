import { isAbsolute } from 'node:path';
import { statSync } from 'node:fs';
import { NAME_PATTERN, envPath, envValues, readEnv, upsert, writeEnv } from './envfile.js';
import { ensureGitignored, gitignoreStatus } from './gitignore.js';
import { CANCELLED, TIMED_OUT, promptForSecret } from './prompt.js';
import { runCommand } from './run.js';

const POPUP_TIMEOUT_SECONDS = 300;
const DEFAULT_COMMAND_TIMEOUT_SECONDS = 120;
const MAX_COMMAND_TIMEOUT_SECONDS = 600;
const MAX_REASON_LENGTH = 200;

function requireProjectDir(dir) {
  if (typeof dir !== 'string' || !isAbsolute(dir)) throw new Error('project_dir must be an absolute path.');
  let stat;
  try {
    stat = statSync(dir);
  } catch {
    throw new Error(`project_dir does not exist: ${dir}`);
  }
  if (!stat.isDirectory()) throw new Error(`project_dir is not a directory: ${dir}`);
  return dir;
}

function requireName(name) {
  if (typeof name !== 'string' || !NAME_PATTERN.test(name)) {
    throw new Error('Secret names must look like environment variables, e.g. OPENAI_API_KEY.');
  }
  return name;
}

function dialogText(name, projectDir, reason, replacing) {
  const lines = [
    `${replacing ? 'Replace' : 'Enter'} the value for ${name}.`,
    '',
    `Saved to: ${envPath(projectDir)}`,
  ];
  if (reason) lines.push('', `Claude's reason: ${reason.slice(0, MAX_REASON_LENGTH)}`);
  lines.push('', 'Claude will not see what you enter here.');
  return lines.join('\n');
}

export async function requestSecret(args, prompt = promptForSecret, timeoutSeconds = POPUP_TIMEOUT_SECONDS) {
  const projectDir = requireProjectDir(args.project_dir);
  const name = requireName(args.name);
  const { updatedGitignore } = ensureGitignored(projectDir);
  const exists = Boolean(envValues(readEnv(projectDir)).get(name));
  if (exists && !args.overwrite) {
    return { status: 'already_set', name, env_file: envPath(projectDir), updated_gitignore: updatedGitignore };
  }

  const answer = await prompt(dialogText(name, projectDir, args.reason, exists), timeoutSeconds);
  if (answer === CANCELLED) return { status: 'cancelled', name };
  if (answer === TIMED_OUT) return { status: 'timed_out', name };
  const value = answer.trim();
  if (value === '') return { status: 'empty', name };

  // Re-read after the popup: the file may have changed while it was open. The
  // read and write are synchronous, so concurrent calls here can't interleave.
  writeEnv(projectDir, upsert(readEnv(projectDir), name, value));
  return {
    status: exists ? 'replaced' : 'saved',
    name,
    env_file: envPath(projectDir),
    updated_gitignore: updatedGitignore,
  };
}

export async function listSecrets(args) {
  const projectDir = requireProjectDir(args.project_dir);
  const values = envValues(readEnv(projectDir));
  return {
    env_file: envPath(projectDir),
    gitignored: gitignoreStatus(projectDir),
    names: [...values.keys()].filter((name) => values.get(name) !== '').sort(),
  };
}

export async function runWithSecrets(args) {
  const projectDir = requireProjectDir(args.project_dir);
  if (typeof args.command !== 'string' || args.command.trim() === '') throw new Error('command is required.');
  if (!Array.isArray(args.secrets) || args.secrets.length === 0) throw new Error('secrets must name at least one secret.');
  args.secrets.forEach(requireName);

  const values = envValues(readEnv(projectDir));
  const missing = args.secrets.filter((name) => !values.get(name));
  if (missing.length > 0) {
    throw new Error(`Not set in ${envPath(projectDir)}: ${missing.join(', ')}. Use request_secret first.`);
  }

  const requested = Number(args.timeout_seconds);
  const timeoutSeconds = requested > 0 ? Math.min(requested, MAX_COMMAND_TIMEOUT_SECONDS) : DEFAULT_COMMAND_TIMEOUT_SECONDS;
  return runCommand({
    command: args.command,
    cwd: projectDir,
    env: Object.fromEntries(args.secrets.map((name) => [name, values.get(name)])),
    // Mask everything in .env, since the command may load the file by itself.
    redactValues: values,
    timeoutSeconds,
  });
}

const projectDirSchema = {
  type: 'string',
  description: 'Absolute path of the project folder whose .env to use.',
};

export const TOOLS = [
  {
    name: 'request_secret',
    description:
      "Ask the user for a secret (API key, token, password) through a native popup on their computer and save it to the project's .env, which is gitignored automatically. The value is never returned to you. Use this instead of asking the user to paste a secret into chat. If the name is already set, this returns already_set without bothering the user; pass overwrite only when the stored value is known to be wrong. Each name appears once in .env.",
    inputSchema: {
      type: 'object',
      properties: {
        project_dir: projectDirSchema,
        name: { type: 'string', description: 'Environment variable name, e.g. OPENAI_API_KEY.' },
        reason: { type: 'string', description: 'Short explanation shown in the popup: what the secret is for and where to find it.' },
        overwrite: { type: 'boolean', description: 'Prompt to replace a value that is already set. Defaults to false.' },
      },
      required: ['project_dir', 'name'],
      additionalProperties: false,
    },
    handler: requestSecret,
  },
  {
    name: 'list_secrets',
    description: "List the names set in the project's .env and whether .env is gitignored. Values are never returned. Use this rather than reading .env yourself.",
    inputSchema: {
      type: 'object',
      properties: { project_dir: projectDirSchema },
      required: ['project_dir'],
      additionalProperties: false,
    },
    handler: listSecrets,
  },
  {
    name: 'run_with_secrets',
    description:
      "Run a shell command in the project folder with the named secrets from .env set as environment variables, so you can use a secret without seeing it. Reference it as a variable, e.g. curl -H \"Authorization: Bearer $OPENAI_API_KEY\" https://api.example.com. Any .env value in the output is masked as [REDACTED:NAME]. Never try to print, transform or exfiltrate a secret.",
    inputSchema: {
      type: 'object',
      properties: {
        project_dir: projectDirSchema,
        command: { type: 'string', description: 'Command for /bin/sh. Runs without stdin.' },
        secrets: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Names from .env to expose to the command.' },
        timeout_seconds: { type: 'number', description: `Defaults to ${DEFAULT_COMMAND_TIMEOUT_SECONDS}; capped at ${MAX_COMMAND_TIMEOUT_SECONDS}.` },
      },
      required: ['project_dir', 'command', 'secrets'],
      additionalProperties: false,
    },
    handler: runWithSecrets,
  },
];
