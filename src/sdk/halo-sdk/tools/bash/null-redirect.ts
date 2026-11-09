/**
 * @module tools/bash/nullRedirect
 * Translate CMD's null-device spelling for commands executed by a POSIX shell.
 * @license MIT
 */

/** This textual compatibility pass does not evaluate shell quoting or expansions. */
export function rewriteWindowsNullRedirect(command: string): string {
  const pieces: string[] = [];
  let copied = 0;
  let scan = 0;

  while (scan < command.length) {
    const operator = command.indexOf('>', scan);
    if (operator < 0) break;
    let target = operator + 1;
    while (target < command.length && command[target].trim() === '') target++;
    scan = target;
    if (command.substring(target, target + 3).toLowerCase() !== 'nul') continue;

    const following = command[target + 3];
    const endsTarget = following === undefined || following.trim() === '' || '|&;)'.includes(following);
    if (endsTarget) {
      pieces.push(command.substring(copied, target), '/dev/null');
      copied = target + 3;
      scan = copied;
    }
  }

  if (copied === 0) return command;
  pieces.push(command.substring(copied));
  return pieces.join('');
}
