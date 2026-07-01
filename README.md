# ishaans-ditto-site

Fork of [ion-design/ditto.site](https://github.com/ion-design/ditto.site) with dual deliverables and frozen live-witness validation.

## What's different

- **Dual output:** Generated Next.js app at `/` + static HTML mirror at `/static/`
- **Frozen evidence:** `source/evidence/live-witness/` (HTML, DOM, screenshots) captured once — gates never re-hit production
- **Unified settle recipe:** `compiler/src/settle/recipe.ts` shared by capture, render, and visual audit
- **Extended gates:** HTML witness (2b), DOM witness triangle (3b/3c), manifest hash (6b), visual audit (7)
- **Benchmark profiles:** `profiles/` for cropin.com, onni.com, everlastingcomfort.com

## Quick start

```bash
npm install
npx playwright install chromium
npm run clone -- https://example.com
```

## Deploy layout

After build, one Vercel/static export serves:

| Path | Content |
|------|---------|
| `/` | Generated Next.js clone |
| `/static/` | Frozen HTML mirror + `/static/assets/cloned/` |

## Architecture docs

See conversation architecture map in repo issues / `docs/ARCHITECTURE.md` (pending).
