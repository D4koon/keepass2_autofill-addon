# TODO

## Automatic updates for self-distributed Firefox builds

Currently `src/manifest.ts` sets no `update_url` for the Gecko build, so
Firefox never checks for new versions of a self-distributed (unlisted)
`.xpi`. Users have to notice a new release and reinstall it by hand.

Signing is already automated: the release workflow signs the beta build via
`npm run sign:xpi:beta` (AMO credentials in the `AMO_API_KEY` /
`AMO_API_SECRET` repository secrets) and attaches
`keelink-<version>-firefox-signed.xpi` to the GitHub release.

Remaining steps:

1. **Generate an `updates.json`** after signing, in the format Mozilla
   requires (see
   https://extensionworkshop.com/documentation/manage/updating-your-extension/),
   containing:
   - the new version number
   - the SHA-256 hash of the signed `.xpi`
   - the GitHub release asset's download URL
   - the extension id from `src/manifest.ts` (`browser_specific_settings.gecko.id`)
2. **Commit that file** to a stable path in the repo (e.g. `updates.json` on
   `master`) as part of the release workflow.
3. **Host it**: simplest option is `raw.githubusercontent.com/<owner>/<repo>/master/updates.json`
   (no extra setup, a few minutes of CDN lag after each push). GitHub Pages
   is a cleaner alternative if that lag or raw's content-type handling ever
   becomes a problem.
4. **Point `update_url` at that URL** in `src/manifest.ts`, under
   `browser_specific_settings.gecko.update_url`.

None of this is needed if the add-on is only side-loaded manually or
eventually listed on AMO (listed add-ons get automatic updates without any
of this).
