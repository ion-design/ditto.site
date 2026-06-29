import { tool } from '@opencode-ai/plugin';

export default tool({
  description:
    'Thin wrapper over the agent-browser CLI. Opens the target URL at the requested viewport, optionally scrolls to a section, waits for networkidle plus a settle delay, then saves a cropped PNG screenshot. Used by clone-validate to capture rendered sections for diff against the captured originals.',
  args: {
    url: tool.schema.string().describe('URL to open (typically http://localhost:3000/)'),
    viewport: tool.schema.number().describe('Viewport width in pixels (height is derived 16:9)'),
    output_path: tool.schema.string().describe('Absolute path to write the PNG to'),
    scroll_y: tool.schema
      .number()
      .nullable()
      .describe('Absolute Y pixel position to scroll to before screenshot. Omit for no scroll.'),
    crop: tool.schema
      .object({
        x: tool.schema.number(),
        y: tool.schema.number(),
        width: tool.schema.number(),
        height: tool.schema.number(),
      })
      .nullable()
      .describe('Crop region to extract from the viewport screenshot. Omit to keep full viewport.'),
    reduce_motion: tool.schema
      .boolean()
      .nullable()
      .describe('If true, adds the `reduce-motion` class to <html> before screenshot. Default false.'),
    settle_ms: tool.schema
      .number()
      .nullable()
      .describe('Extra ms to wait after networkidle before screenshot. Default 500.'),
  },
  async execute(args, context) {
    const { spawn } = await import('node:child_process');
    const { resolve, dirname } = await import('node:path');
    const { mkdirSync, existsSync } = await import('node:fs');
    const { resolvePython } = await import('./_python.js');

    const python = resolvePython(context.worktree);
    const outPath = resolve(context.worktree, args.output_path);
    const outDir = dirname(outPath);
    if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

    const height = Math.round((args.viewport * 9) / 16);
    const session = `clone-validate-${args.viewport}`;

    const steps: string[][] = [
      ['--session', session, 'set', 'viewport', String(args.viewport), String(height)],
      ['--session', session, 'open', args.url],
      ['--session', session, 'wait', '--load', 'networkidle'],
    ];

    if (args.reduce_motion ?? false) {
      steps.push(['--session', session, 'eval', 'document.documentElement.classList.add("reduce-motion")']);
    }

    if (args.scroll_y != null) {
      steps.push(['--session', session, 'eval', `window.scrollTo({ top: ${args.scroll_y}, behavior: "instant" })`]);
    }

    steps.push(['--session', session, 'wait', String(args.settle_ms ?? 500)]);
    steps.push(['--session', session, 'screenshot', outPath]);

    for (const argv of steps) {
      await new Promise<void>((resolvePromise, reject) => {
        const child = spawn('agent-browser', argv, { stdio: 'inherit' });
        child.on('exit', (code) => {
          if (code === 0) resolvePromise();
          else reject(new Error(`agent-browser ${argv.join(' ')} exited ${code}`));
        });
        child.on('error', reject);
      });
    }

    if (args.crop != null) {
      await new Promise<void>((resolvePromise, reject) => {
        const child = spawn(
          python,
          [
            '-c',
            `from PIL import Image; import sys; im=Image.open(sys.argv[1]); im.crop((${args.crop!.x}, ${
              args.crop!.y
            }, ${args.crop!.x + args.crop!.width}, ${args.crop!.y + args.crop!.height})).save(sys.argv[1])`,
            outPath,
          ],
          { stdio: 'inherit' }
        );
        child.on('exit', (code) => (code === 0 ? resolvePromise() : reject(new Error(`crop failed ${code}`))));
        child.on('error', reject);
      });
    }

    return JSON.stringify({ output_path: outPath, viewport: args.viewport });
  },
});
