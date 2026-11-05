# AGENTS.md

## What this is

IINA plugin (plain JavaScript, no build step) that skips, lists and submits SponsorBlock
segments. `Info.json` is the manifest; `main.js` is the entry; `lib/sponsorblock.js` holds the pure
logic; `ui/` holds the preferences and sidebar pages; `test/logic.test.js` is the unit suite.

## Build and test

- `make test` — `node --check` on `main.js` and `lib/sponsorblock.js`, validate `Info.json`, run
  the logic tests.
- `make build` — stage `dist/SponsorBlock.iinaplugin/` and pack `dist/SponsorBlock.iinaplgz`.
- `make link` / `make unlink` — symlink/unlink this repo as an `.iinaplugin-dev` in
  `~/Library/Application Support/com.colliderli.iina/plugins` (restart IINA after).
- `dist/` is git-ignored; never commit it.

The `.iinaplgz` is a zip whose **contents sit at the archive root**: `Info.json` must be at the
root, not wrapped in a `SponsorBlock.iinaplugin/` directory. IINA unpacks with
`unzip <pkg> <tmp>-1 && mv <tmp>-1/* <tmp>/` and then reads `<tmp>/Info.json`
(`JavascriptPlugin.create(fromPackageURL:)`).

## Installing

IINA → Settings → Plugins → *Install from GitHub…* → `kvndrsslr/iina-sponsorblock`. IINA uses the
latest release's `.iinaplgz`; the plugin stays disabled until enabled once in that pane.

## Releasing

`Info.json` drives both installation and auto-update:

- `ghRepo` must stay `kvndrsslr/iina-sponsorblock`.
- `ghVersion` is an integer. IINA fetches
  `https://raw.githubusercontent.com/<ghRepo>/main/Info.json` and prompts when the remote
  `ghVersion` is greater than the installed one.
- IINA installs a release asset whose name ends in `.iinaplgz` from the latest release.

Steps:

1. Bump `version` (semver) and increment `ghVersion` in `Info.json`.
2. Commit and push `main`.
3. Tag `v<version>` — the tag must equal `Info.json`'s `version` — and push the tag.
4. The `Release` workflow (`.github/workflows/release.yml`) runs `make test` and `make build` on
   Ubuntu, then attaches `dist/SponsorBlock.iinaplgz` to the GitHub release.
5. Verify with `gh release view v<version> -R kvndrsslr/iina-sponsorblock` and by downloading the
   asset without authentication.

A published tag is immutable. Ship fixes with a new `version` and a higher `ghVersion`; do not move
or reuse a released tag. Pushing only to `main` does not prompt installed users — that requires a
higher `ghVersion`, which is why it is bumped together with `version` at release time.
