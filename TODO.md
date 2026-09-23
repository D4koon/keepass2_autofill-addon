# TODO

## Automatic updates for self-distributed Firefox builds

Currently `src/manifest.ts` sets no `update_url` for the Gecko build, so
Firefox never checks for new versions of a self-distributed (unlisted)
`.xpi`. Users have to notice a new release and reinstall it by hand.

To fix this:

1. **Get an AMO API key** (needed either way, since AMO signing is required
   for Firefox to install the `.xpi` at all): on addons.mozilla.org under
   Tools → Manage API Keys, generate a JWT issuer + secret.
2. **Add them as GitHub secrets**: `AMO_API_KEY` and `AMO_API_SECRET`, under
   Settings → Secrets and variables → Actions.
3. **Enable the signing step** that already exists, commented out, in
   `.github/workflows/release.yaml` (search for `sign:xpi:beta`). It calls
   `npm run sign:xpi:beta`, which runs `web-ext sign --channel=unlisted` and
   writes the signed `.xpi` to `dist/signed/`.
4. **Attach the signed `.xpi` to the GitHub release**: add `dist/signed/**`
   to the `files:` list of the `Release` step.
5. **Generate an `updates.json`** after signing, in the format Mozilla
   requires (see
   https://extensionworkshop.com/documentation/manage/updating-your-extension/),
   containing:
   - the new version number
   - the SHA-256 hash of the signed `.xpi`
   - the GitHub release asset's download URL
   - the extension id from `src/manifest.ts` (`browser_specific_settings.gecko.id`)
6. **Commit that file** to a stable path in the repo (e.g. `updates.json` on
   `master`) as part of the release workflow.
7. **Host it**: simplest option is `raw.githubusercontent.com/<owner>/<repo>/master/updates.json`
   (no extra setup, a few minutes of CDN lag after each push). GitHub Pages
   is a cleaner alternative if that lag or raw's content-type handling ever
   becomes a problem.
8. **Point `update_url` at that URL** in `src/manifest.ts`, under
   `browser_specific_settings.gecko.update_url`.

None of this is needed if the add-on is only side-loaded manually or
eventually listed on AMO (listed add-ons get automatic updates without any
of this).
