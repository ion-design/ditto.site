import { tool } from '@opencode-ai/plugin';

export default tool({
  description:
    'Download every asset referenced in the capture bundle into the target Next.js project public directory using hash-based filenames. Wraps scripts/download-assets.py. Returns lists of downloaded, failed, and skipped URLs.',
  args: {
    manifest_path: tool.schema
      .string()
      .describe('Path to meta.json from capture (or manifest.json after analyze) — whichever has assets[]'),
    project_public_dir: tool.schema
      .string()
      .describe('Path to <project>/public/assets/cloned where assets are written'),
  },
  async execute(args, context) {
    const { spawn } = await import('node:child_process');
    const { resolve } = await import('node:path');
    const { resolvePython } = await import('./_python.js');

    const scriptPath = resolve(context.worktree, '.opencode/scripts/download-assets.py');
    const manifestPath = resolve(context.worktree, args.manifest_path);
    const publicDir = resolve(context.worktree, args.project_public_dir);
    const python = resolvePython(context.worktree);

    let stdout = '';
    let stderr = '';

    await new Promise<void>((resolvePromise, reject) => {
      const child = spawn(python, [scriptPath, '--manifest', manifestPath, '--public-dir', publicDir, '--json'], {
        cwd: context.worktree,
      });
      child.stdout.on('data', (chunk) => (stdout += chunk.toString()));
      child.stderr.on('data', (chunk) => (stderr += chunk.toString()));
      child.on('exit', (code) => {
        if (code === 0) resolvePromise();
        else reject(new Error(`download-assets.py exited with code ${code}: ${stderr}`));
      });
      child.on('error', reject);
    });

    const result = JSON.parse(stdout.trim().split('\n').pop() ?? '{}');
    return JSON.stringify({
      downloaded: result.downloaded ?? [],
      failed: result.failed ?? [],
      skipped: result.skipped ?? [],
    });
  },
});
