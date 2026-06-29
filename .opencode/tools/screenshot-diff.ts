import { tool } from '@opencode-ai/plugin';

export default tool({
  description:
    'Pixel-diff two PNG screenshots using pixelmatch. Returns diff percentage, path to a diff image with changed pixels highlighted, and bounding boxes of the worst regions (top connected components of changed pixels).',
  args: {
    before: tool.schema.string().describe('Path to the captured original PNG'),
    after: tool.schema.string().describe('Path to the rendered clone PNG'),
    threshold: tool.schema.number().nullable().describe('pixelmatch per-pixel color tolerance 0-1. Default 0.1.'),
    diff_out: tool.schema
      .string()
      .nullable()
      .describe('Path to write the diff PNG to. Default: same dir as after with -diff suffix.'),
  },
  async execute(args, context) {
    const { spawn } = await import('node:child_process');
    const { resolve, dirname, basename, extname, join } = await import('node:path');
    const { resolvePython } = await import('./_python.js');

    const scriptPath = resolve(context.worktree, '.opencode/scripts/diff.py');
    const beforePath = resolve(context.worktree, args.before);
    const afterPath = resolve(context.worktree, args.after);
    const python = resolvePython(context.worktree);
    const diffOut =
      args.diff_out != null
        ? resolve(context.worktree, args.diff_out)
        : join(dirname(afterPath), `${basename(afterPath, extname(afterPath))}-diff.png`);

    let stdout = '';
    let stderr = '';

    await new Promise<void>((resolvePromise, reject) => {
      const child = spawn(
        python,
        [
          scriptPath,
          '--before',
          beforePath,
          '--after',
          afterPath,
          '--diff-out',
          diffOut,
          '--threshold',
          String(args.threshold ?? 0.1),
          '--json',
        ],
        { cwd: context.worktree }
      );
      child.stdout.on('data', (chunk) => (stdout += chunk.toString()));
      child.stderr.on('data', (chunk) => (stderr += chunk.toString()));
      child.on('exit', (code) => {
        if (code === 0) resolvePromise();
        else reject(new Error(`diff.py exited with code ${code}: ${stderr}`));
      });
      child.on('error', reject);
    });

    const result = JSON.parse(stdout.trim().split('\n').pop() ?? '{}');
    return JSON.stringify({
      diff_pct: result.diff_pct ?? 100,
      diff_image_path: diffOut,
      worst_regions: result.worst_regions ?? [],
    });
  },
});
