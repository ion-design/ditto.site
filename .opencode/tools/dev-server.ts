import { tool } from '@opencode-ai/plugin';

export default tool({
  description:
    "Start, stop, or health-check the Next.js dev server for the generated clone project. Use action='health' to check if a server is already responding at url; action='start' to spawn `bun run dev` in project_dir; action='stop' to kill the pid from a prior start.",
  args: {
    action: tool.schema.enum(['health', 'start', 'stop']).describe('Which lifecycle action to perform'),
    project_dir: tool.schema.string().nullable().describe('Path to the generated Next.js project (required for start)'),
    url: tool.schema.string().nullable().describe('Base URL to health-check. Default http://localhost:3000'),
    port: tool.schema.number().nullable().describe('Port for `bun run dev` when starting. Default 3000.'),
    pid: tool.schema.number().nullable().describe('Pid to kill when action=stop'),
  },
  async execute(args, context) {
    const { spawn } = await import('node:child_process');
    const { resolve } = await import('node:path');
    const url = args.url ?? 'http://localhost:3000';

    if (args.action === 'health') {
      try {
        const res = await fetch(url, { method: 'HEAD' });
        return JSON.stringify({ healthy: res.ok || res.status === 404, status: res.status, url });
      } catch {
        return JSON.stringify({ healthy: false, status: 0, url });
      }
    }

    if (args.action === 'start') {
      if (!args.project_dir) throw new Error('project_dir is required for action=start');
      const cwd = resolve(context.worktree, args.project_dir);
      const port = args.port ?? 3000;
      const child = spawn('bun', ['run', 'dev', '--port', String(port)], {
        cwd,
        detached: true,
        stdio: 'ignore',
      });
      child.unref();

      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        try {
          const res = await fetch(url, { method: 'HEAD' });
          if (res.ok || res.status === 404) {
            return JSON.stringify({ status: 'started', url, pid: child.pid });
          }
        } catch {}
        await new Promise((r) => setTimeout(r, 1000));
      }
      return JSON.stringify({ status: 'timeout', url, pid: child.pid });
    }

    if (args.action === 'stop') {
      if (args.pid == null) throw new Error('pid is required for action=stop');
      try {
        process.kill(args.pid, 'SIGTERM');
        return JSON.stringify({ status: 'stopped', pid: args.pid });
      } catch (err) {
        return JSON.stringify({ status: 'error', pid: args.pid, error: String(err) });
      }
    }

    throw new Error(`unknown action ${args.action}`);
  },
});
