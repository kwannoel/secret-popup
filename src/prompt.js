import { execFile } from 'node:child_process';
import { constants } from 'node:os';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('./popup.applescript', import.meta.url));

export const CANCELLED = Symbol('cancelled');
export const TIMED_OUT = Symbol('timed out');

// If this process is stopped (e.g. Claude's Bash tool times out), an orphaned
// popup would stay on screen and quietly discard whatever the user typed.
const openPopups = new Set();
process.on('exit', () => openPopups.forEach((child) => child.kill()));
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(signal, () => process.exit(128 + constants.signals[signal]));
}

// Text goes through argv, so a crafted name or reason can't inject AppleScript.
// The secret comes back over stdout, so it never appears in a process listing.
// /usr/bin/osascript is absolute so that PATH can't substitute another binary.
export function promptForSecret(dialogText, timeoutSeconds) {
  if (process.platform !== 'darwin') {
    return Promise.reject(new Error('The secret popup currently only supports macOS.'));
  }
  return new Promise((resolve, reject) => {
    const child = execFile('/usr/bin/osascript', [SCRIPT, dialogText, String(timeoutSeconds)], (error, stdout, stderr) => {
      openPopups.delete(child);
      if (!error) return resolve(stdout.replace(/\r?\n$/, ''));
      if (stderr.includes('-128')) return resolve(CANCELLED);
      if (stderr.includes('-1712')) return resolve(TIMED_OUT);
      reject(new Error(`The popup failed to open: ${stderr.trim() || error.message}`));
    });
    openPopups.add(child);
  });
}
