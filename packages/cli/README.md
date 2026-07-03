# ditto (CLI)

The official ditto.site command-line helper. Turns a clone **result JSON** —
the giant blob you get back from `POST /v1/clones` or
`GET /v1/clones/:id/result` — into an actual project tree on disk.

Zero dependencies. Needs Node >= 20.

This workspace is currently private and repo-local. Run these commands from the
repository root after `npm install`; do not use `npx ditto` until the package is
published.

## Unpack

```bash
# from a saved file
npm run unpack -- clone.json ./out

# straight from curl, no temp file
curl -sS -X POST "$DITTO_API_URL/v1/clones" \
  -H "authorization: Bearer $DITTO_API_KEY" \
  -H "content-type: application/json" \
  -d '{"url":"https://example.com/","options":{"mode":"single"}}' \
  | npm run --silent unpack -- - ./out
```

`npm run unpack -- <clone.json|-> <out-dir>`:

- writes every text file from its inline `content`,
- materializes binary assets from inline base64 when present, otherwise fetches
  them from their reference `url`,
- refuses paths that escape `<out-dir>` and verifies `sha256` when the result
  carries it.

### Binary assets

Clone results return binaries by reference (`{ "type": "binary", "url": ... }`)
rather than inlining megabytes of base64. To fetch them, the unpacker needs to
know where the API lives:

| Source | Flag | Env |
| --- | --- | --- |
| Base URL for relative asset URLs | `--base-url <url>` | `DITTO_API_URL` |
| Bearer key for authenticated APIs | `--api-key <key>` | `DITTO_API_KEY` |

Use `--no-fetch` to write only the text tree and list the binaries as skipped.
To grab everything in one shot instead, download the archive directly:
`GET /v1/clones/<id>/bundle?format=tgz`.

Run `npm run unpack -- --help` for the full option list.
