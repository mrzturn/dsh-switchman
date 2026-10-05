# dsh-switchman Release Checklist (a Release triggers automatic publishing)

> Status: **ready to ship**. The release method matches opencode-switchman: publish a GitHub Release from the main branch and `publish.yml` completes the npm publish automatically (OIDC, tokenless), running after manual approval of the `release-publish` environment.

## One-Time Setup (done by hand before the first release)

1. **npmjs.com Trusted Publisher**: npm account → package name `dsh-switchman` → Trusted Publishing; bind the repository `mrzturn/dsh-switchman`, the workflow `.github/workflows/publish.yml`, and the environment `release-publish` (the same OIDC scheme as opencode-switchman, no long-lived NPM_TOKEN).
2. **GitHub environment**: repo Settings → Environments → create `release-publish`; configure required reviewers (the release-approval gate) + the deployment branch rule `v*` (release runs carry refs/tags/*).
3. The workflow needs npm >= 11.5.1 (node 24 is already pinned).

## Completed Readiness Items (2026-10-01; shape figures re-verified 2026-10-02)

- [x] Marketplace surface: icon.svg (517B), locale/{en,zh}.json display meta, exports `./locale/*.json`, `dsh.manifestVersion: 1`, `engines.dsh: >=0.2.0-rc.0`
- [x] Dependencies: the single dependency `@deepseek-ai/schemastery@3.18.4` (the same version as the host, zero peer dependencies → nothing for the install precheck to reject)
- [x] Precise files enumeration: `npm pack --dry-run` = **50 files / ~205 kB (re-verified 2026-10-05) / zero node_modules** (includes the 11-language READMEs and host/ui-locale.js; skill-local dependencies install via setup.sh on first use; docs/ screenshots never ship, with a CI leak-prevention assertion)
- [x] Redaction scan: a repo-wide grep (credential patterns / personal paths / intranet addresses / Bearer tokens) hit only public GitHub URLs and the docs/ directory holding this file (docs/ is not in files and does not ship with the package)
- [x] validate.mjs: all 4 checks green (patch matches the factory presets field by field / client discovery surface / marketplace surface / skills complete)
- [x] Bilingual README (README.md English + README.zh.md Chinese)
- [x] Behavior verification: validate + node --check in full + 33 Host-side mock test groups + a Client-side mini-React smoke pass (three-phase regression)
- [x] Release pipeline `.github/workflows/publish.yml`: release published trigger → main branch only → tag vs package.json version consistency check → `npm ci` → validate → pack leak check → environment approval → `npm publish` (OIDC)

## Release-Day Procedure

1. Confirm locally that `node scripts/validate.mjs` is all green and `npm pack --dry-run` keeps the 50-file shape (CI runs it again anyway).
2. Re-run the redaction scan (the grep above; expect only public URLs).
3. Version check: the version in `package.json` matches the Release tag about to ship (`v1.3.0` ↔ `1.3.0`; CI hard-validates it).
4. On GitHub, tag `v*` off main and publish the Release → Actions waits for `release-publish` environment approval → after approval, `npm publish` runs automatically.
5. Post-release smoke test: on a fresh profile, `plugin_manager inspect target=dsh-switchman` → `install_bundle` → fully restart DSH → verify the badge / settings page / `[SWITCHMAN:...]` behavior triple.
6. If listing on dsh-market or similar directory sites, supplement the repo metadata per their submission conventions (topics, screenshots).

## Known Boundaries (quotable in release notes)

- Live end-to-end behavior (real tokenMeter measurement, compaction coordination, command UI rendering) awaits user verification on the desktop app; the mock layer already covers all of it.
- If a DSH upgrade changes the factory preset plugin list, cordis.patch.yml must be re-synced (see the maintenance note in the README).
- Protocol lines (`[SWITCHMAN:*]`) stay English — capture anchors depend on byte stability.
