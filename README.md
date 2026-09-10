# Simple and secure password management

## Kee automatically fills login forms to save you time and protect you from security risks.

Kee is a free Firefox and Chrome add-on for linking browsers to [Kee Vault](https://keevault.pm) or KeePass (latter requires using the [KeePassRPC KeePass plugin](https://github.com/kee-org/keepassrpc)).

Official website with sign-up and download links: https://www.kee.pm

Support forum: https://forum.kee.pm

# Build

## Requirements

* node 20.19 or higher (required by web-ext 10 and vite 7; CI uses 20)
* a node package manager (tested with npm 8, 9 and 10)
* a web browser (tested with Firefox 117)
* a Supporter's subscription to [Kee Vault](https://keevault.pm) OR KeePass 2.x (+ .NET/Mono) + KeePassRPC.plgx

It's set up for Visual Studio Code but it shouldn't be too hard to work out how to develop using other IDEs.

## Instructions

1. clone the repo
1. `npm ci` (or `npm install` to get any newer library dependencies than those we used in official builds)
1. Development:
   1. Open two terminals/consoles
      1. In the 1st, run the build task for your target browser:
         * Chrome: `npm run dev-chrome` (or `npm run dev`) - extension pages are served from the Vite dev server with hot module reloading
         * Firefox: `npm run dev-firefox` - extension pages are bundled to disk instead. Firefox rejects the `http://localhost` entry that the dev server needs in the extension `content_security_policy` (https://bugzilla.mozilla.org/show_bug.cgi?id=1864284), so `npm run dev` leaves the popup, options and panels blank there. `dev-firefox` still rebuilds on every save but does not do in-place HMR.
      1. In the 2nd: `npm run start:firefox` OR `npm run start:chrome`
         * `web-ext` auto-detects the browser. If it can't find yours, or you want a specific build, point it at the binary with an env var before running the script:
           * Firefox: `WEB_EXT_FIREFOX` (e.g. Windows `set WEB_EXT_FIREFOX=C:\Program Files\Mozilla Firefox\firefox.exe`, macOS/Linux `export WEB_EXT_FIREFOX=/path/to/firefox`)
           * Chrome/Chromium: `WEB_EXT_CHROMIUM_BINARY`
         * On some Linux setups `web-ext` fails to create the temporary profile under `/tmp`; work around it with `mkdir -p ~/tmp-dir && export TMPDIR=~/tmp-dir` first.
   1. the task in the 1st terminal will recompile and reload necessary parts of the addon each time you change a file but in some circumstances you'll need to press 'r' in the 2nd terminal to force a complete reload.
   1. Keep the 1st and 2nd terminal commands on the same browser. Mismatched pairs mostly still work but produce console warnings - and for Firefox paired with `npm run dev` you get the non-functional UI described above.
1. Preparing for release or Pull Request:
   1. `npm run tsc` to verify that no type errors have been introduced during recent development changes
   1. `npm run lint` (`npm run lint:fix` to auto-fix formatting)
   1. `npm run test`

You may need to modify the vite config files or some of the build scripts if you add significant new sections to the WebExtension structure but it's unlikely and we can help you with that if necessary.

### VS Code tasks (Firefox)

`.vscode/tasks.json` wraps the Firefox commands above so you don't have to juggle two terminals by hand. Run them from **Terminal > Run Task...**, or press `Ctrl+Shift+B` for the default (**Kee: Build & Run in Firefox**). Each task carries a one-line description in the picker.

| Task | What it does |
| --- | --- |
| **Kee: Build & Run in Firefox** *(default build task)* | Runs `build:prod` to completion, then launches Firefox with the built `./extension`. One-off; does not watch for changes. |
| **Kee: Dev (watch + Firefox)** | Starts the watch build (`dev-firefox`), waits for the first build, then launches Firefox. `web-ext` reloads the extension as you edit; press `r` in the Firefox terminal to force a full reload. This is the one to use for day-to-day development. |
| Kee: Build (production) | Just `npm run build:prod` - no browser launched. |
| Kee: Run in Firefox | Just `npm run start:firefox` against whatever is already in `./extension`. |
| Kee: Dev build (watch) | Just `npm run dev-firefox` - the watch build on its own. |

The Firefox tasks use `web-ext`, which needs a `firefox` binary on `PATH` (or the `WEB_EXT_FIREFOX` env var - see above) and reuses the throw-away profile in `./.testing-web-ext-firefox-profile`.

## Reproducing a build

### Introduction

Exactly reproducing the files delivered from the Firefox add-on website or Chrome extension store is not possible because the websites modify the file that we build in order to attach a digital signature. One can get very close though, to the point where a diff of the files from a given release on GitHub varies from your own local build in only three ways:

1. Line endings - some parts of the tool chain may treat line endings differently so that the end result could differ between operating systems.
2. Version number - the CI build system holds credentials that allow it to manipulate git tags on the GitHub repository and in doing so allows for automatic incrementing of build numbers, which in turn will result in a unique version number being calculated. This can only be reproduced if you download the git repo to your local system (including all tags) and develop a custom build script or modify the source files as needed - it's most likely not worth the effort but can be done if it is important to you.
3. File dates - the build output is essentially a zip file so when the newly downloaded and built files on your system are added to the zip file, they will have different dates than those that were built on the CI platform and automatically added to a GitHub Release. For this reason, even if you were to end up with the same line endings and version number, it is not possible to compare a digest (hash) of your built file and expect it to match the file built by anyone else (unless you build it at exactly the same time!)

### Requirements

Reproducible builds rely upon npm version 7 or higher.

Our builds are created by GitHub Actions using the following configuration:

* Ubuntu 22.04
* Node 20
* npm 10

### Instructions

1. download the source code (e.g. from the relevant GitHub Release page) or clone the repo for the latest (often pre-release) version
1. `npm ci && mkdir dist`
1. manipulate package.json if you want to adjust version numbers
1. For a Firefox release: `npm run build:prod && npm run pack:prod` (for stable releases) and/or `npm run build:beta && npm run pack:beta` (for beta releases) 
1. For a Chromium release: `npm run build-chrome:prod && npm run pack-chrome:prod` (for stable releases) and/or `npm run build-chrome:beta && npm run pack-chrome:beta` (for beta releases) 
1. XPIs and ZIPs of each variant are put into the `dist` folder

## Repo/project structure

* `/_locales` Localisation data (language translations).
* `.tx` Used by Transifex localisation scripts to help manage multiple language translation.
* `dist` Output folder for build packages (e.g. an XPI file for installation in Firefox). Created automatically by development scripts or manually if you're only building for packaging/release.
* `extension` Output folder for compiled files when developing or building for packaging/release.
* `lib` Files that are directly included in the resulting extension, undergoing no further adjustment or compilation.
* `scripts` The scripts within help prepare the `extension` file structure for hot module reloading during development, as well as ensuring that various categories of files end up in the right place, with appropriate references updated.
* `src` 
   * `manifest.ts` Outputs a manifest.json file appropriate to the current build / development environment.
   * `assets` Static assets. These may be manipulated by the build process into a different format or excluded entirely from the final output but typically will just be included as is, into the extension/assets folder.
   * `background` Extension's main background script / Service Worker.
   * `common` Modules that are used across multiple extension scopes (e.g. background, popup, content script, etc.) 
   * `dialogs` Standalone dialogs within the extension context (e.g. for the Network Authentication window).
   * `install-notes` A Vue app that is shown after an extension installation has occurred.
   * `page` The content page script that gets injected to every web page that is not Kee Vault.
   * `panels` Small pages that are rendered as in-page panels, within an iframe, within any web page.
   * `popup` The main browser popup that clicking on the browser toolbar button will display.
   * `release-notes` Pages that are shown after an extension update has occurred.
   * `settings` Page to allow user to adjust many extension settings.
   * `store` The Pinia Store definitions that are used for both Vue/Vuetify UI state storage and for automated data transfer across multiple extension execution scopes (popup, settings page, background, in-page panels, etc.)
   * `vault` The content page script that gets injected to the Kee Vault website.

## Vue devtools

It's likely that the below does not work. It might though, at least on one or two devices in the world when the stars are aligned.

We'll take a fresh look at this challenge when working on the migration to MV3.

### One time:
````
npm install -g @vue/devtools
npm install -g https-proxy-cli
````

### Each time:

`https-proxy -t http://localhost:8098 -p 8099 --keys <folder to store and re-access self-signed certs> &`
`vue-devtools`

### First time:

sudo apt-get install libnss3-tools
Manually load https://localhost:8099 in the browser, add self-signed cert to whitelist and export the cert to a local file (or just use the generated keys folder location above... not sure if that will work or not).
`certutil -d sql:$HOME/.pki/nssdb -A -t "P,," -n <path to saved cert> -i <path to saved cert>`
restart Chrome

