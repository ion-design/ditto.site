# Methodology

ditto.site is built as a deterministic capture-to-code compiler. The goal is not
to author a plausible page from a prompt; it is to preserve what a browser
actually rendered and turn that evidence into a runnable app with repeatable
output.

## Principles

- **Observed evidence first.** The compiler starts from browser-captured DOM,
  computed styles, layout boxes, CSS, assets, fonts, metadata, screenshots, and
  interaction or motion signals when they can be observed safely.
- **Deterministic output.** A frozen capture should produce byte-stable app
  output. Randomness, timestamps, network state, and heuristic ordering are kept
  out of generated files.
- **Generated code over screenshots.** The output is a Next.js or Vite React app
  with local assets, route modules, metadata, CSS, and small runtime helpers for
  recognized interactions. Screenshots are used for validation, not delivery.
- **No private app replay.** Authenticated state, payments, personalization,
  business logic, arbitrary third-party scripts, and access-controlled content
  are not recreated.
- **Safety is part of correctness.** SSRF controls, rate limits, artifact
  boundaries, and responsible-use limits are treated as part of the system, not
  deployment afterthoughts.

## Development Loop

1. **Capture a representative fixture or benchmark page.** The browser capture
   records the rendered page and the artifacts needed to reconstruct it.
2. **Normalize into a render IR.** Capture data is converted into stable
   sections, tokens, assets, semantic metadata, and interaction candidates.
3. **Generate the app.** The generator emits framework files, styles, assets,
   route structure, metadata, runtime helpers, and handoff docs.
4. **Validate by building and rendering.** Browser-backed checks compare source
   and clone behavior, including structure, screenshots, links, SEO metadata,
   responsive layout, interactions, and motion where supported.
5. **Lock regressions with focused tests.** Changes that affect compiler output
   should add or update a fixture, unit test, or benchmark note so the behavior
   remains explainable.
6. **Keep the service wrapper thin.** The REST, MCP, queue, database, and storage
   packages call the compiler through the public barrel instead of reaching into
   compiler internals.

## Validation Gates

The repository uses small, repeatable gates rather than one broad visual score:

- TypeScript typechecking across every workspace.
- Node test suites for compiler output, API behavior, storage, cache keys, SSRF,
  auth, MCP contracts, and queue/worker paths where infrastructure is available.
- Browser-gated fixture tests through Playwright and Chromium.
- Determinism checks that regenerate from one frozen capture and compare output.
- Optional benchmark runs for broader visual or route coverage.

Heavy real-site benchmark sweeps are kept outside the default CI path. CI should
stay fast enough to run on every pull request; broader benchmark evidence is
attached when a change materially affects clone output.

## Review Standard

Compiler changes should answer three questions:

- What new source evidence is captured or interpreted?
- How does generation stay deterministic?
- Which fixture, test, or benchmark proves the behavior?

Service changes should keep the hosted API and MCP contracts stable, preserve
auth and SSRF guarantees, and avoid changing compiler semantics from the service
layer.

## Safety Boundaries

See [RESPONSIBLE_USE.md](RESPONSIBLE_USE.md) and [SECURITY.md](../SECURITY.md)
for the public-use and deployment controls. Changes that make phishing,
impersonation, access-control bypass, unbounded third-party capture, or unsafe
fetching easier are out of scope for this project.
