# ditto.site Documentation

The central index for ditto.site's docs. Start here.

> **First, the word "clone."** In ditto.site, *cloning* means **generating a
> codebase from a live URL** — it is **not** `git clone`. You do **not** need an
> existing Git repository, and you do **not** need the target site's source code.
> You give ditto.site a public URL; it captures what the page renders in a browser
> and writes you a fresh, runnable project. (The only `git clone` involved is
> optionally cloning *this tool's* repository to run the compiler locally.)

## Get started

| I want to… | Go to |
| --- | --- |
| Understand what ditto.site is and see it run | [Project README](../README.md) |
| Call the hosted **REST API** or **MCP** server | [Project README → Usage](../README.md#usage), [SERVICE.md](SERVICE.md) |
| Turn a clone result JSON into files on disk | [Repo-local unpack CLI](../packages/cli/README.md) |
| Run the **compiler locally** from the command line | [compiler/README.md](../compiler/README.md) |
| Deploy the service | [DEPLOY.md](DEPLOY.md) |
| Read the development & evaluation method | [METHODOLOGY.md](METHODOLOGY.md) |
| Understand responsible-use boundaries | [RESPONSIBLE_USE.md](RESPONSIBLE_USE.md) |
| Cut a release | [RELEASING.md](RELEASING.md) |

## API keys are secrets

Keys look like `dtto_live_...`. Keep them in an environment variable and reference
it in commands:

```bash
export DITTO_API_KEY="dtto_live_..."
curl -sS -H "authorization: Bearer $DITTO_API_KEY" "$DITTO_API_URL/v1/clones"
```

Never paste a raw key inline (it leaks into shell history, logs, and chat), and
never commit one. Rotate a leaked key anytime from the dashboard. See
[SERVICE.md](SERVICE.md) for the full auth model.

## The short version of the workflow

1. **Clone** a URL → `POST /v1/clones` (API) or `npm run clone -- <url>` (local CLI).
2. **Get the app** → unpack the result JSON with the [repo-local unpack CLI](../packages/cli/README.md),
   download the `bundle?format=tgz` archive, or read files from `runs/<site>/latest/`.
3. **Preview it** → `cd` into the app and `npm install && npm run dev` (or let the
   local CLI do it for you with `--serve` / `--open`).
4. **Edit safely** → each generated app ships an `AGENTS.md` describing what's safe
   to change (copy in `src/app/content.ts`, components in `src/app/components/`, etc.).

## Full doc list

- [SERVICE.md](SERVICE.md) — REST + MCP service reference (endpoints, options, env vars).
- [DEPLOY.md](DEPLOY.md) — production deployment.
- [METHODOLOGY.md](METHODOLOGY.md) — how the compiler is developed and evaluated.
- [RESPONSIBLE_USE.md](RESPONSIBLE_USE.md) — acceptable-use boundaries.
- [RELEASING.md](RELEASING.md) — release process.
- [../compiler/README.md](../compiler/README.md) — local compiler commands.
- [../packages/cli/README.md](../packages/cli/README.md) — the repo-local unpack CLI.
