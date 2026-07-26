# Releasing obsbot-mcp

Releases are automated: pushing a `vX.Y.Z` git tag triggers
`.github/workflows/release.yml`, which builds the native helper for every
supported triple (`win32-x64`, `linux-x64`, `darwin-arm64`, `darwin-x64`),
publishes the package to npm via **OIDC trusted publishing** (no tokens),
publishes `server.json` to the [MCP Registry](https://registry.modelcontextprotocol.io)
(also OIDC), and creates a GitHub Release with the helper binaries attached.

Adding a triple means touching the build matrix **and** the `publish` job,
which downloads each artifact by name — a matrix entry alone builds a helper
that never reaches the tarball.

## One-time bootstrap (already done for 0.1.0)

npm requires a package to exist before a trusted publisher can be configured,
so the first version was published manually:

1. `npm login`
2. `npm publish --access public`  (publishes the current `package.json` version)
3. On npmjs.com → **obsbot-mcp** → **Settings** → **Trusted Publisher** →
   **GitHub Actions**: repository `lxman/obsbot-mcp`, workflow `release.yml`.

After that, all releases are automated and require no npm credentials.

## Cutting a release

1. Ensure `master` is green in CI.
2. Bump the version everywhere it is declared — `package.json`, the MCP server
   handshake in `src/mcp/server.ts`, all three native helpers, and **both**
   version fields in `server.json`. `test/version-sync.test.ts` fails if any
   site drifts, so `npm test` tells you when you have them all.
3. Commit: `git commit -am "release: 0.1.1"`.
4. Tag and push:
   ```bash
   git tag v0.1.1
   git push origin master --tags
   ```
5. The Release workflow builds, guards that the tag matches `package.json` and
   `server.json`, publishes to npm, publishes to the MCP Registry, and creates
   the GitHub Release.

## Testing the pipeline without publishing

Run the Release workflow manually with the default `dry_run: true`:

```bash
gh workflow run release.yml -f dry_run=true
```

This builds the helper, stages it, verifies the tarball, and runs
`npm publish --dry-run` — it never publishes or creates a Release.

> **Note:** `npm publish --dry-run` does a registry preflight, so it fails with
> *"cannot publish over the previously published versions"* if `package.json` is
> at a version already on npm. Run the dry-run when `master` is at the **next,
> unpublished** version (i.e. after bumping), or expect that one step to report
> the duplicate — the build/stage/tarball checks before it still validate the pipeline.

## The MCP Registry

The registry hosts **metadata only** — `server.json` points at the npm package,
which is where the actual code lives. Ownership is proved by the `mcpName` field
in `package.json`: the registry fetches the published npm package and refuses the
publish unless that field equals `server.json`'s `name`. Both are
`io.github.lxman/obsbot-mcp`, and `test/version-sync.test.ts` pins them together.

The `io.github.lxman/` prefix is not decorative. GitHub OIDC only authorises that
namespace, so renaming the server to anything else means switching to
[DNS authentication](https://modelcontextprotocol.io/registry/authentication)
on a domain we control.

Registry publishing runs **after** npm publish and is skipped on dry runs, since
there would be no package for it to point at. The workflow polls npm until the
new version is actually being served before invoking `mcp-publisher` — `npm
publish` returns before the registry API is guaranteed to serve the version, and
the validator reads that API.

Verify a release landed:

```bash
curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.lxman/obsbot-mcp"
```

`server.json` is deliberately **not** in `package.json`'s `files` allowlist —
`mcp-publisher` reads it from the repo checkout, not from the tarball.

## What ships in the package

The npm tarball is limited by `package.json`'s `files` allowlist to
`dist/` and `native/prebuilt/`. Nothing else is published.
