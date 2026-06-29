# Releasing

ditto.site is pre-1.0. The repository is MIT-licensed, but the npm workspaces are
marked `private` until the package boundaries and distribution story are ready
for public npm publishing.

## Release Checklist

1. Start from a clean `main` checkout.
2. Run `npm ci` and `npx playwright install chromium`.
3. Run `npm run typecheck` and `npm test`.
4. Run `npm audit --omit=dev --audit-level=moderate` for runtime dependencies.
5. For compiler-output changes, run focused fixtures or benchmarks and record
   the result in the pull request.
6. Update [CHANGELOG.md](../CHANGELOG.md), moving relevant entries out of
   `Unreleased`.
7. Update package versions if a source release is being tagged.
8. Create an annotated Git tag and GitHub release.

## Versioning

Until `1.0.0`, minor and patch versions may include breaking changes. Document
user-facing breakage in the changelog and prefer migration notes when the change
affects generated output, API shape, database schema, or deployment settings.

## Publishing

Do not remove `private: true` from workspaces as part of a routine source
release. Publishing to npm needs a separate review of package names, build
artifacts, export maps, provenance, and long-term API compatibility.
