import { tool } from '@opencode-ai/plugin';

export default tool({
  description:
    'Open a URL (typically the local dev server at http://localhost:3000) and dump its DOM + computed styles using the same __CLONE_DUMP_COMPUTED__ walker the source capture pipeline uses. Produces a directly-comparable structural snapshot the validate agent can pass to dom-diff. Wraps scripts/dump-rendered.py.',
  args: {
    url: tool.schema.string().describe('URL to dump, typically http://localhost:3000/'),
    output: tool.schema.string().describe('Path to write the rendered DOM JSON (the section snapshot file)'),
    viewport: tool.schema.number().nullable().describe('Viewport width in px. Default 1280.'),
    viewport_height: tool.schema
      .number()
      .nullable()
      .describe('Viewport height in px. Default = 16:9 of viewport width.'),
    scroll_y: tool.schema.number().nullable().describe('Y position to scroll to before dumping. Default 0.'),
    reduce_motion: tool.schema
      .boolean()
      .nullable()
      .describe('Add reduce-motion class to <html> before dumping (matches the Stage 1 validate gate). Default false.'),
    settle_ms: tool.schema.number().nullable().describe('Extra ms to wait after scroll before dumping. Default 800.'),
  },
  async execute(args, context) {
    const { spawn } = await import('node:child_process');
    const { resolve } = await import('node:path');
    const { resolvePython } = await import('./_python.js');

    const scriptPath = resolve(context.worktree, '.opencode/scripts/dump-rendered.py');
    const outPath = resolve(context.worktree, args.output);
    const python = resolvePython(context.worktree);

    const cmdArgs = [scriptPath, '--url', args.url, '--output', outPath];
    if (args.viewport != null) cmdArgs.push('--viewport', String(args.viewport));
    if (args.viewport_height != null) cmdArgs.push('--viewport-height', String(args.viewport_height));
    if (args.scroll_y != null) cmdArgs.push('--scroll-y', String(args.scroll_y));
    if (args.reduce_motion ?? false) cmdArgs.push('--reduce-motion');
    if (args.settle_ms != null) cmdArgs.push('--settle-ms', String(args.settle_ms));

    let stdout = '';
    let stderr = '';
    await new Promise<void>((resolvePromise, reject) => {
      const child = spawn(python, cmdArgs, { cwd: context.worktree });
      child.stdout.on('data', (chunk) => (stdout += chunk.toString()));
      child.stderr.on('data', (chunk) => (stderr += chunk.toString()));
      child.on('exit', (code) => {
        if (code === 0) resolvePromise();
        else reject(new Error(`dump-rendered.py exited ${code}: ${stderr}`));
      });
      child.on('error', reject);
    });

    const result = JSON.parse(stdout.trim().split('\n').pop() ?? '{}');
    return JSON.stringify({
      status: result.status ?? 'success',
      output: result.output ?? outPath,
      sections_path: result.sections_path,
      section_count: result.section_count ?? 0,
    });
  },
});
