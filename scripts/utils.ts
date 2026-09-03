import { resolve } from "path";
import { bgCyan, black } from "kolorist";
import * as url from "url";
const __dirname = url.fileURLToPath(new URL(".", import.meta.url));

export const port = parseInt(process.env.PORT || "") || 3303;
export const r = (...args: string[]) => resolve(__dirname, "..", ...args);
export const isDev = process.env.NODE_ENV !== "production";
export const isBeta = process.env.VITE_KEE_CHANNEL === "beta";
export const isChrome = process.env.BROWSER_TARGET === "chrome";

// Dev build that bundles the extension pages to disk instead of loading them
// from the Vite dev server. Needed for Firefox, where http://localhost in the
// extension_pages CSP is rejected (https://bugzilla.mozilla.org/show_bug.cgi?id=1864284),
// which otherwise leaves the popup/options/panels blank.
export const bundledDev = process.env.KEE_BUNDLED_DEV === "true";

export function log(name: string, message: string) {
  console.log(black(bgCyan(` ${name} `)), message);
}
