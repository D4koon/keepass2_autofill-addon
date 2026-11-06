# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

KeeLink: a Firefox/Chrome (Manifest V3) WebExtension that autofills logins from KeePass via the KeePassRPC plugin. It's a fork of the Kee add-on with the Kee Vault and online-account features removed. Licence: AGPL-3.0. Written in TypeScript, Vue 3, Vuetify 3, Pinia and Vite. Node `^20.19 || >=22.12`.

## Commands

```sh
npm ci
npm run dev-firefox      # watch build to ./extension (Firefox can't use the Vite dev server, so no HMR)
npm run dev-chrome       # Vite dev server + HMR for extension pages
npm run start:firefox    # in a 2nd terminal: web-ext runs ./extension (press 'r' to force reload)
npm run start:chrome

npm run build:prod       # Firefox production build -> ./extension (Chrome: build-chrome:prod)
npm run pack:prod        # zip ./extension into dist/*.xpi (Chrome: pack-chrome:prod)

npm run tsc              # vue-tsc --noEmit; needs a prior build/dev run because Vite generates d.ts files
npm run lint             # eslint (lint:fix to auto-fix)
npm test                 # vitest run (all tests: unit + browser)
npm run test:unit        # jsdom/node unit tests only (fast, no browsers needed)
npm run test:browser     # real-browser tests in Chromium + Firefox
npx playwright install chromium firefox      # one-time, before the first browser test run
npx vitest run src/tests/keeUrl.test.ts      # single file
npx vitest run -t "name of test"             # single test by name
npm run test:coverage    # unit tests only
npm run bench            # benchmarks of the content script's hot paths, in Chromium + Firefox; not part of npm test
```

Before a release or PR, run `tsc`, `lint` and `test`. The VS Code task **Kee: Dev (watch + Firefox)** in `.vscode/tasks.json` combines the watch build and the Firefox launch.

Build-time env flags (see `scripts/utils.ts`): `NODE_ENV`, `BROWSER_TARGET=chrome`, `VITE_KEE_CHANNEL=beta`, `KEE_BUNDLED_DEV`. They become the compile-time constants `__DEV__` and `__IS_CHROME__`.

## Build layout

Three separate Vite builds write into `./extension`:
- `vite.config.ts`: the HTML extension pages (popup, settings, panels, SRP/NetworkAuth dialogs, install/update notes) → `extension/dist/`. It also holds the shared config (the `~/` alias to `src/`, auto-imports of `vue` and the `$`/`$$`/`$STR`/`$STRF` helpers from `common/DollarPolyfills`, icons, UnoCSS) and the vitest config.
- `vite.config.background.ts`: the service worker `src/background/main.ts`.
- `vite.config.page.ts`: the content script `src/page/page.ts`, built as an IIFE to `extension/dist/page/index.global.js`.

`scripts/prepare.ts` writes `manifest.json` (generated from `src/manifest.ts`, which differs per browser), copies the locales, assets and `lib/`, and sets up the dev stubs. If you add a new page entry, update both the rollup inputs in `vite.config.ts` and the manifest/scripts.

`src/auto-imports.d.ts` and `src/components.d.ts` are generated.

## Architecture

**Execution contexts.** The add-on runs in several separate contexts:
- background: `src/background/`
- content script, injected into every frame: `src/page/`
- popup: `src/popup/`
- in-page iframe panels: `src/panels/`
- settings: `src/settings/`
- dialogs: `src/dialogs/`

These contexts talk to each other only over `chrome.runtime.Port` connections (`common/port.ts`), using the `AddonMessage` shape with an `Action` enum (`common/AddonMessage.ts`, `common/Action.ts`). In the background, `background/messageHandlers.ts` routes the messages per source: `browserPopupMessageHandler`, `pageMessageHandler` and `iframeMessageHandler`.

**Shared state.** `store/` defines a single `KeeState`. State changes are `Mutation`s (`store/mutation-types.ts`) that get broadcast between contexts:
- The background owns the authoritative copy (`store/BackgroundStore.ts`, which extends `NonReactiveStore`). It rebroadcasts each mutation to every other port.
- Vue UIs use a Pinia store (`store/index.ts`). `common/IPCPiniaPlugin.ts` forwards local mutations to the background.
- The content script uses a `NonReactiveStore`.

To add new shared state, you need a mutation type, a handler in `NonReactiveStore.onRemoteMessage`, and the matching Pinia action.

**KeePass connection.** The `Kee` singleton in `background/KF.ts` (exported as `kee`) is the central coordinator. It uses `background/kprpcClient.ts`, which speaks JSON-RPC (`jsonrpcClient.ts`) over a WebSocket (`WebsocketSession.ts`, `ws://127.0.0.1:12546` by default) to KeePassRPC. Authentication uses SRP (`background/SRP.ts`) and the `dialogs/SRP` pairing page; the session key is then reused. Keyboard commands are in `background/commands.ts`, and HTTP auth prompts in `background/NetworkAuth.ts`.

**Form matching and filling** (`src/page/`):
- `formScanner.ts` / `formsUtils.ts`: find forms and fields, including inside shadow DOM.
- `relevanceScoring.ts` / `entryRanking.ts`: score KeePass entries against those fields.
- `fillDecision.ts`: decides whether to autofill or autosubmit.
- `formFilling.ts` / `fieldFilling.ts`: perform the fill.
- `formSaving.ts`: captures submitted credentials.
- `fillDiagnostics.ts` and `common/diagnosisReport.ts`: produce the "diagnose fill" report shown in the popup (`popup/components/DiagnoseFillReport.vue`).

Most unit tests cover this area, using `src/tests/helpers/formFillingHarness.ts` with jsdom.

`docs/form-filling.adoc` (AsciiDoc with PlantUML) describes the rules: login-form detection, the scores, the username guess (`FormUtils.pickUsernameIndex`) and the tie order when filling (`byScore` in `fieldFilling.ts`). Update it when you change one of them.

**Config.** `common/config.ts` defines `Config` and the per-site `SiteConfig`. `common/ConfigManager.ts` persists them to `chrome.storage`. When the schema changes:
1. Bump the version.
2. Add a `migrateToVersionN` method in `common/ConfigMigrations.ts`, and wire it up in `ConfigManager`.
3. Add a test.

The built-in per-site defaults are in `common/DefaultSiteConfig.ts`.

**i18n.** Look up UI strings with `$STR("key")` / `$STRF("key", [subs])`. The keys live in `_locales/<lang>/messages.json`; `en` is the source locale.

## Tests

Vitest runs with `root: src`, `environment: node` and `globals: true`. `src/tests/setup.ts` installs a minimal in-memory `chrome` stub covering storage, runtime and similar APIs. Extend it when the code under test needs more of the API. Coverage includes `common`, `page`, `store` and `background`; there are no `.vue` component tests.

There are two vitest projects (see `test.projects` in `vite.config.ts`):
- `unit`: everything in `src/tests/` except `src/tests/browser/`. jsdom tests opt in with `// @vitest-environment jsdom`.
- `browser`: `src/tests/browser/**`, run in real headless Chromium and Firefox via `@vitest/browser` + Playwright. Use it for code that depends on layout, the CSS cascade or hit-testing (`getBoundingClientRect`, `elementsFromPoint`, shadow DOM styling), which jsdom does not do — e.g. the field icon overlay. Each test builds a small fixture page reproducing a real-site layout. Known unfixed gaps are written as `it.fails`; flip them to `it` when fixed.

**Benchmarks.** `src/tests/browser/bench/page.bench.ts` runs in real Chromium and Firefox (the browser project; the unit project runs no benchmarks). It measures the scan, the shadow-root walk, form fields and the page observer's checks on a large synthetic page (`bench/busyPage.ts`). When a change touches `src/page/` code that runs on every scan or DOM change, measure it rather than guessing:
1. Run `npm run bench -- --outputJson bench-before.json` on the old code (e.g. after `git stash`).
2. Run `npm run bench -- --compare bench-before.json` on the new code.
3. Report the difference. The JSON file lands in `src/` (vitest's root) and is git-ignored.

Runs on unchanged code differ by about ±30%, sometimes up to 2×, so trust only larger differences that hold over a repeat run. Don't benchmark in jsdom: its DOM is far slower than a browser's in places (a scan took about 200× longer, nearly all of it in jsdom's HTML collections), so a jsdom profile points at the wrong code. Layout-dependent code (icon and panel positioning) isn't covered. Performance checks that must hold belong in the unit tests as counts (how often something is searched or scheduled, as in `rescanTrigger.test.ts`), never as timings.

## Conventions

- Indentation is 4 spaces, except 2 in `package.json`. Line endings are LF. Use double quotes and semicolons (ESLint enforces these).
- Log through `KeeLog` (`common/Logger.ts`) rather than `console`.

## Release / CI

**Every push to `master` publishes a release.** Two workflows release, and they run the same steps:
- `.github/workflows/master.yaml` (Master CI) runs on each push to `master` and publishes a GitHub **pre-release**. This is the normal way releases are made.
- `.github/workflows/release.yaml` (Release CI) runs on a push to a `release/*` branch and publishes a full release. It is rarely used.

Each run:
- auto-tags the version: it increments the patch number when `package.json`'s major.minor matches the last tag reachable from the pushed commit, and otherwise uses major.minor.0
- commits the version bump ("Release x.y.z") and pushes it, with the tag, back to the branch it ran on
- builds Chrome and Firefox in both prod and beta variants
- runs `tsc`, the unit and browser tests, and lint
- signs the Firefox XPI with AMO (`sign:xpi:beta`, using the `AMO_API_KEY`/`AMO_API_SECRET` secrets). AMO refuses to sign a version twice, and a failed step stops the run before anything is pushed or published.

Consequences:
- Because of the version commit, local `master` falls behind after every push: `git pull` before working on or pushing anything else.
- Don't push the same commits to `master` and a `release/*` branch together: both runs compute the same version and one of them fails.
- After a `release/*` run, its version commit is only on that branch; merge it into `master`.
- Don't hand-edit `version` for a release.

`TODO.md` lists the outstanding work for Firefox auto-updates (`update_url`).
