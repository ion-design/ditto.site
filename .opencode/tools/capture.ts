import { tool } from '@opencode-ai/plugin';

export default tool({
  description:
    'Run the Playwright-based site capture pipeline against a target URL. Produces a full capture bundle (DOM + computed styles per scroll position, screenshots per viewport, HAR, animation library dumps, shaders, CSS rules + url() asset refs, fonts, per-section cropped screenshots, alt-height pass for vh detection) at output_dir. Wraps scripts/capture.py. Set replay=true to skip capture entirely and only re-run the post-process (vh-flags + meta.json) against an existing capture bundle — use this when iterating on prompts/agents/skills.',
  args: {
    url: tool.schema
      .string()
      .nullable()
      .describe('Absolute target URL, e.g. https://example.com. Required unless replay=true.'),
    viewports: tool.schema
      .array(tool.schema.number())
      .nullable()
      .describe('Viewport widths in pixels to capture, e.g. [375, 768, 1280, 1920]. Default [375,768,1280,1920].'),
    output_dir: tool.schema
      .string()
      .describe('Directory where the capture bundle is written (absolute path or relative to cwd)'),
    wait_strategy: tool.schema
      .enum(['networkidle', 'load', 'domcontentloaded'])
      .nullable()
      .describe('Playwright wait strategy for navigation. Default networkidle.'),
    skip_third_party: tool.schema
      .boolean()
      .nullable()
      .describe('If true, blocks requests to known third-party widget domains. Default true.'),
    replay: tool.schema
      .boolean()
      .nullable()
      .describe(
        'If true, skip browser capture entirely and only re-run post-process (vh-flags + meta.json) against existing capture data in output_dir. ~100x faster than a real capture.'
      ),
    skip_alt_height: tool.schema
      .boolean()
      .nullable()
      .describe('If true, skip the vh-detection alt-height pass at canonical width. Saves ~10s.'),
    skip_section_shots: tool.schema
      .boolean()
      .nullable()
      .describe('If true, skip the per-section cropped screenshot pass. Saves ~30s.'),
  },
  async execute(args, context) {
    const { spawn } = await import('node:child_process');
    const { resolve } = await import('node:path');
    const { readFileSync, existsSync } = await import('node:fs');
    const { resolvePython } = await import('./_python.js');

    const scriptPath = resolve(context.worktree, '.opencode/scripts/capture.py');
    const outputDir = resolve(context.worktree, args.output_dir);
    const python = resolvePython(context.worktree);
    const replay = args.replay ?? false;

    if (!replay && !args.url) {
      throw new Error('capture: url is required unless replay=true');
    }

    const viewports = args.viewports ?? [375, 768, 1280, 1920];

    const cmdArgs = [scriptPath, '--output', outputDir];
    if (args.url) cmdArgs.push('--url', args.url);
    if (viewports.length) cmdArgs.push('--viewports', viewports.join(','));
    cmdArgs.push('--wait-strategy', args.wait_strategy ?? 'networkidle');
    if (args.skip_third_party ?? true) cmdArgs.push('--skip-third-party');
    if (replay) cmdArgs.push('--replay');
    if (args.skip_alt_height ?? false) cmdArgs.push('--skip-alt-height');
    if (args.skip_section_shots ?? false) cmdArgs.push('--skip-section-shots');

    await new Promise<void>((resolvePromise, reject) => {
      const child = spawn(python, cmdArgs, { cwd: context.worktree, stdio: 'inherit' });
      child.on('exit', (code) => {
        if (code === 0) resolvePromise();
        else reject(new Error(`capture.py exited with code ${code}`));
      });
      child.on('error', reject);
    });

    const metaPath = resolve(outputDir, 'meta.json');
    if (!existsSync(metaPath)) {
      throw new Error(`capture.py did not produce ${metaPath}`);
    }
    const meta = JSON.parse(readFileSync(metaPath, 'utf-8'));

    return JSON.stringify({
      status: 'success',
      mode: replay ? 'replay' : 'capture',
      capture_dir: outputDir,
      viewports: meta.viewports ?? viewports,
      dom_snapshots: meta.dom_snapshots ?? 0,
      screenshots: meta.screenshots ?? 0,
      section_shots: meta.section_shots ?? 0,
      assets_discovered: Array.isArray(meta.assets) ? meta.assets.length : 0,
      asset_sources: meta.asset_sources ?? null,
      libs_detected: meta.libs_detected ?? [],
      vh_relative_count: meta.vh_relative_count ?? 0,
      canvas_regions: meta.canvas_regions ?? 0,
    });
  },
});
