import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// False if the query fails for any reason: no repo, no git, or a "no" answer.
function git(dir, ...args) {
  try {
    execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const isGitRepo = (dir) => git(dir, 'rev-parse', '--git-dir');
const isTracked = (dir) => git(dir, 'ls-files', '--error-unmatch', '--', '.env');
const isIgnored = (dir) => git(dir, 'check-ignore', '-q', '--', '.env');

// Makes sure .env can't be committed. Runs before the popup, so the user is
// never asked for a secret that couldn't be stored safely.
export function ensureGitignored(dir) {
  const inRepo = isGitRepo(dir);
  if (inRepo) {
    if (isTracked(dir)) {
      throw new Error(`.env is already tracked by git in ${dir}, so secrets written to it could be committed. Untrack it first with: git rm --cached .env`);
    }
    if (isIgnored(dir)) return { updatedGitignore: false };
  }

  const path = join(dir, '.gitignore');
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
  // Outside a repo git can't answer, so look for the entry directly. Inside a
  // repo we only get here if .env isn't ignored, possibly because of a later
  // `!.env`, so the new entry has to be appended either way.
  if (!inRepo && existing.split(/\r?\n/).some((line) => line.trim() === '.env')) {
    return { updatedGitignore: false };
  }
  const separator = existing === '' || existing.endsWith('\n') ? '' : '\n';
  appendFileSync(path, `${separator}.env\n`);

  if (inRepo && !isIgnored(dir)) {
    throw new Error(`Added .env to ${path}, but git still doesn't ignore it. Check the repo's ignore rules.`);
  }
  return { updatedGitignore: true };
}

export function gitignoreStatus(dir) {
  if (isGitRepo(dir)) return isIgnored(dir) && !isTracked(dir);
  const path = join(dir, '.gitignore');
  return existsSync(path) && readFileSync(path, 'utf8').split(/\r?\n/).some((line) => line.trim() === '.env');
}
