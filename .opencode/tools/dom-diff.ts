import { tool } from '@opencode-ai/plugin';

export default tool({
  description:
    'Structural diff between two DOM JSON snapshots produced by __CLONE_DUMP_COMPUTED__ — one from the source capture, one from the rendered clone (via dump-rendered). Returns a ranked list of concrete issues (missing elements, wrong dimensions, style mismatches) the generate agent can act on directly. Wraps scripts/dom-diff.py.',
  args: {
    captured: tool.schema.string().describe('Path to the captured DOM JSON (e.g. capture/dom/1280/step-00.json)'),
    rendered: tool.schema.string().describe('Path to the rendered DOM JSON produced by dump-rendered'),
    root_selector: tool.schema
      .string()
      .nullable()
      .describe(
        'Optional — scope the diff to a subtree, e.g. "#hero" or ".ecosystem". Omit to diff the whole document.'
      ),
    max_depth: tool.schema.number().nullable().describe('Recursion depth cap. Default 8.'),
    max_issues: tool.schema
      .number()
      .nullable()
      .describe('Cap on the number of structured issues returned. Default 200.'),
  },
  async execute(args, context) {
    const { spawn } = await import('node:child_process');
    const { resolve } = await import('node:path');
    const { resolvePython } = await import('./_python.js');

    const scriptPath = resolve(context.worktree, '.opencode/scripts/dom-diff.py');
    const capturedPath = resolve(context.worktree, args.captured);
    const renderedPath = resolve(context.worktree, args.rendered);
    const python = resolvePython(context.worktree);

    const cmdArgs = [scriptPath, '--captured', capturedPath, '--rendered', renderedPath];
    if (args.root_selector) cmdArgs.push('--root-selector', args.root_selector);
    if (args.max_depth != null) cmdArgs.push('--max-depth', String(args.max_depth));
    if (args.max_issues != null) cmdArgs.push('--max-issues', String(args.max_issues));

    let stdout = '';
    let stderr = '';
    await new Promise<void>((resolvePromise, reject) => {
      const child = spawn(python, cmdArgs, { cwd: context.worktree });
      child.stdout.on('data', (chunk) => (stdout += chunk.toString()));
      child.stderr.on('data', (chunk) => (stderr += chunk.toString()));
      child.on('exit', (code) => {
        if (code === 0 || code === 2 || code === 3) resolvePromise();
        else reject(new Error(`dom-diff.py exited ${code}: ${stderr}`));
      });
      child.on('error', reject);
    });

    const result = JSON.parse(stdout.trim().split('\n').pop() ?? '{}');
    return JSON.stringify({
      matched: result.matched ?? 0,
      counts: result.counts ?? {},
      issues: result.issues ?? [],
      structured_issues: result.structured_issues ?? [],
      error: result.error ?? null,
    });
  },
});
