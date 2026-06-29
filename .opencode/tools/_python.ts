import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export function resolvePython(worktree: string): string {
  const venvPython = resolve(worktree, '.opencode/scripts/.venv/bin/python');
  if (existsSync(venvPython)) return venvPython;
  return 'python3';
}
