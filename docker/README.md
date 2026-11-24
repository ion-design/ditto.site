# Runtime image maintenance

Build both services from the reviewed source revision. A certificate-only overlay
over an older application image does not update its application or operating-system
packages.

```sh
docker build --platform linux/amd64 -f docker/api.Dockerfile -t ditto-api:candidate .
docker build --platform linux/amd64 -f docker/worker.Dockerfile -t ditto-worker:candidate .
```

Both images use the same digest-pinned Node 22 / Debian Trixie base, apply available
OS updates, update npm's bundled dependencies, and provide `/opt/aws/rds-ca.pem`
for RDS TLS configuration.
The public AWS trust bundle is checksum-pinned. Revalidate its checksum when
updating the bundle. Application secrets are supplied by the deployment, never
copied into the image.

`tsx` is a runtime dependency because both services execute TypeScript. Development
packages are omitted from the images. The worker installs Chromium and its required
system packages using the lockfile's Playwright version, without the unused Firefox
and WebKit stacks. Keep the Playwright package and browser installation together.
The existing `tini` process reaper and per-worker harness paths remain in place.

The generated Next.js applications and both harness manifests use the patched
Next 15 maintenance release. The PostCSS override also applies to generated
applications so they do not reinstall Next's older pinned transitive version.

Before promoting a new digest, run type checking, the existing browser/API/worker
tests, image vulnerability scans, and a local Chromium launch/fixture capture.
Verify the API health endpoint and credential denial behavior in an isolated
environment. Deployment still requires the established workload handoff and an
RDS TLS/application check; a local image scan does not clear the running-image
findings or establish compatibility with an unknown historical source revision.

References: [Playwright custom containers](https://playwright.dev/docs/docker),
[AWS RDS trust bundle](https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem).
