# Experimental Ion CMS handoff

This integration is private, versioned, and opt-in. Existing REST, MCP, core,
and compiler callers keep the current clone behavior unless they send the exact
`ion-cms-v1` flag on a multi-page clone.

## Start a handoff clone

The handoff is deliberately a strict two-job flow. First run the normal
single-page clone and retain its `jobId`. Then discover and plan the site. The
flagged multi-page request must name that exact successful entry job:

```json
{
  "url": "https://example.com/",
  "options": {
    "mode": "multi",
    "experimentalContentHandoff": "ion-cms-v1",
    "experimentalReuseCaptureJobId": "4f33d2f9-5904-4ea2-bfe9-f63664acc001",
    "experimentalClonePlan": {
      "version": "ion-clone-plan-v1",
      "entryRoute": "/",
      "staticRoutes": [],
      "manifests": [],
      "renderers": [],
      "dispositions": []
    }
  }
}
```

Any other flag value is rejected. The flag is also rejected in single-page
mode and currently requires the default Next.js framework. A flagged request
without both an explicit plan and `experimentalReuseCaptureJobId` is rejected;
there is no ambiguous experimental fallback. The referenced job must be a
successful single-page clone of the same normalized URL and its capture must
still be available. Flagged and unflagged requests use different cache keys.

## Agent-planned clones

Ion may split the flagged workflow into discovery and capture. Discovery is
also private and requires the exact flag:

```json
POST /v1/discoveries
{
  "url": "https://example.com/",
  "experimentalContentHandoff": "ion-cms-v1"
}
```

The `ion-clone-discovery-v1` response contains every discovered route, its
entry-link label and page region where available, sitemap/link provenance, and
candidate URL clusters. Discovery does not perform full responsive captures.

Ion then sends the plan as `options.experimentalClonePlan` together with the
single-page job ID:

```json
{
  "version": "ion-clone-plan-v1",
  "entryRoute": "/",
  "staticRoutes": ["/about"],
  "manifests": [{ "key": "products", "entityType": "product" }],
  "renderers": [
    {
      "key": "product-detail",
      "role": "detail",
      "pattern": "/collections/[productType]/[id]",
      "captureUrl": "/collections/wallets/example",
      "manifestKeys": ["products"],
      "aliases": ["/products/[id]"]
    },
    {
      "key": "product-alias",
      "role": "detail",
      "pattern": "/products/[id]",
      "reuseRendererKey": "product-detail",
      "manifestKeys": ["products"]
    }
  ],
  "dispositions": [
    { "path": "/about", "kind": "static" },
    {
      "path": "/products/example",
      "kind": "renderer",
      "rendererKey": "product-alias"
    }
  ]
}
```

Plans separate CMS entities from route renderers: one manifest may feed several
nested or aliased routes, and several renderers may reuse one captured visual
template. A planned clone captures the entry, every `staticRoutes` item, and one
`captureUrl` per distinct renderer-reuse root with the existing bounded route
concurrency. It does not run the legacy route selection or sibling confirmation
passes. Omitting either the plan or exact reuse job ID rejects the flagged
request. Omitting the handoff flag retains the legacy public behavior.

## Artifact contract

A successful flagged clone includes:

```text
.ion/ditto-content-bundle.json
```

The JSON object has:

- `schema: "ion-cms-v1"` and `version: 1`
- `source`, including the source URL, origin, detected platform, and
  `scope: "cms-manifests"` for planned handoffs
- deterministic `families` keyed from arbitrary planned manifests
- each family's Ion-ready collection key, label, description, import origin,
  route pattern, representative static module, field schema, and extracted
  entries
- a disposition for every in-scope route: `cloned`, `cms`, `passthrough`, or
  `unresolved`
- aggregate `coverage` counts
- deterministic `contentHash` values on every entry plus top-level
  `manifestHash`
- `extraction` metadata naming the adapter/version, deterministic extraction
  date, counts, and structured per-manifest failures
- for explicitly planned jobs only, additive `plannedClone` data containing the
  validated plan, successfully captured renderer representatives, and explicit
  route failures

There are no runtime timestamps or random identifiers in the bundle.
`extraction.extractedAt` is derived deterministically from the newest imported
publish date (or the Unix epoch when none exists). Generic/Shopify JSON-LD
extraction uses the complete bounded crawl/sitemap inventory for each planned
dynamic route pattern, up to 10,000 total entries. WordPress sites use the
same-origin public REST API to enumerate viewable post types and retain full
entry bodies. Generic content fetches use eight concurrent requests, a
15-second timeout, and a 5 MiB response limit.

Only successfully extracted records receive the `cms` disposition. Routes that
cannot be safely extracted fail closed and retain Ditto's existing
representative-link behavior. Account, cart, checkout, and search routes are
marked as source passthrough where applicable.

## Ion importer requirements

The Ion-side agent should:

1. Verify both `schema === "ion-cms-v1"` and `version === 1`. Stop on any
   unknown schema or version.
2. Verify `manifestHash`, every entry `contentHash`, extraction counts, and
   that every planned manifest produced either a family or a failure bearing
   its `manifestKey`.
3. Call Ion's collection upsert for each item in `families`, passing `key`,
   `label`, `description`, `fieldSchema`, and `origin: "import"`.
4. Upsert each item in `family.entries` by `family.key` plus `entry.slug`: call
   `getEntryBySlug`; create it with `routePath`, `document`, and
   `source: "import"` when absent, or update its draft and route identity when
   present. This makes repeated imports idempotent.
5. Build a dynamic route from `family.routePattern` and use
   `family.template.module` as the static visual reference. Bind the CMS
   document fields to that route's component props.
6. Preserve normal internal links for `cms` and `cloned` routes.
7. Send `passthrough` routes to their `targetUrl`.
8. Leave `unresolved` routes on Ditto's safe representative fallback and report
   them to the user instead of silently creating broken pages.
9. Publish imported entries when the project workflow permits it; public
   dynamic routes only resolve published CMS entries.
10. Report the imported family/item counts and the bundle's coverage counts.

The representative module is a visual source, not yet a prop-driven component.
Ion owns the final extraction of that static page into a reusable dynamic
template and must keep the static representative route working while doing so.

An all-static plan uses empty `manifests` and `renderers`, lists every cloned
page in `staticRoutes`, and still emits `plannedClone`, `extraction`, and
`manifestHash`. Unknown manifest types are imported by the WordPress adapter
when backed by a matching public post type; generic JSON-LD falls back to a
page-shaped document while preserving the planned family key and entity kind.

## Expected effect

Ditto still browser-clones only the small set of visually distinct routes
selected by the route planner. Product and collection siblings found on the
landing page are fetched as structured content in bounded parallel and handed
to Ion for CMS-backed dynamic routes. This is the path for making dozens of
landing-page links work without running visual clone/validation loops for every
item.
