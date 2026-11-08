import { spawn } from 'node:child_process';

const MAX_OUTPUT_BYTES = 1024 * 1024;
const MIN_REDACTED_LENGTH = 4;

// Values under MIN_REDACTED_LENGTH are skipped: masking every "1" or "on" would
// make output unreadable, and values that short aren't credentials.
function redactionRules(values) {
  const rules = [];
  for (const [name, value] of values) {
    if (value.length < MIN_REDACTED_LENGTH) continue;
    // The trailing-newline form is what `echo "$KEY" | base64` produces.
    const forms = new Set([
      value,
      encodeURIComponent(value),
      Buffer.from(value).toString('base64'),
      Buffer.from(`${value}\n`).toString('base64'),
    ]);
    for (const form of forms) rules.push({ form, label: `[REDACTED:${name}]` });
  }
  return rules.sort((a, b) => b.form.length - a.form.length);
}

function redact(text, rules) {
  return rules.reduce((result, { form, label }) => result.split(form).join(label), text);
}

function collector(stream) {
  const chunks = [];
  let size = 0;
  let truncated = false;
  stream.on('data', (chunk) => {
    const room = MAX_OUTPUT_BYTES - size;
    if (chunk.length > room) truncated = true;
    if (room > 0) {
      const kept = chunk.subarray(0, room);
      chunks.push(kept);
      size += kept.length;
    }
  });
  return () => ({ text: Buffer.concat(chunks).toString('utf8'), truncated });
}

function finish({ text, truncated }, rules) {
  if (!truncated) return redact(text, rules);
  // The cut may have split a secret, leaving a prefix that no rule would match.
  // Drop as much of the tail as the longest form could occupy.
  const longest = rules[0]?.form.length ?? 0;
  const safe = text.slice(0, Math.max(0, text.length - longest));
  return `${redact(safe, rules)}\n[output truncated]`;
}

// Runs a shell command with `env` added to its environment. Everything it prints
// is masked using `redactValues`, a Map of every value that must not be echoed.
export function runCommand({ command, cwd, env, redactValues, timeoutSeconds }) {
  const rules = redactionRules(redactValues);
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', ['-c', command], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true, // Own process group, so a timeout also kills its children.
    });
    const stdout = collector(child.stdout);
    const stderr = collector(child.stderr);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // Already exited.
      }
      // A process that left the group could hold the pipes open forever.
      child.stdout.destroy();
      child.stderr.destroy();
    }, timeoutSeconds * 1000);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({
        exit_code: code,
        ...(signal ? { signal } : {}),
        ...(timedOut ? { timed_out: true } : {}),
        stdout: finish(stdout(), rules),
        stderr: finish(stderr(), rules),
      });
    });
  });
}
