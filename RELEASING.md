# Releasing obsbot-mcp

Releases are automated: pushing a `vX.Y.Z` git tag triggers
`.github/workflows/release.yml`, which builds the Windows native helper,
publishes the package to npm via **OIDC trusted publishing** (no tokens),
and creates a GitHub Release with the helper binary attached.

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
2. Bump the version in `package.json` (e.g. `0.1.1`) and commit:
   `git commit -am "release: 0.1.1"`.
3. Tag and push:
   ```bash
   git tag v0.1.1
   git push origin master --tags
   ```
4. The Release workflow builds, guards that the tag matches `package.json`,
   publishes to npm, and creates the GitHub Release.

## Testing the pipeline without publishing

Run the Release workflow manually with the default `dry_run: true`:

```bash
gh workflow run release.yml -f dry_run=true
```

This builds the helper, stages it, verifies the tarball, and runs
`npm publish --dry-run` — it never publishes or creates a Release.

## What ships in the package

The npm tarball is limited by `package.json`'s `files` allowlist to
`dist/` and `native/prebuilt/`. Nothing else is published.
