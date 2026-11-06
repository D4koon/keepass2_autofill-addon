import { type FormUtils } from "./formsUtils";

// What the content script's mutation observer (page.ts) does with each batch of
// DOM changes: which changes are worth a rescan of the frame (a form scan and a
// KeePassRPC round-trip), and how long to wait before it. This runs on every
// change a page makes, so busy pages must stay cheap here.

// Only a newly added <form> or a text-like input is worth a full rescan +
// KeePassRPC round-trip. Ignoring range/checkbox/radio/hidden/submit inputs
// stops dashboards (e.g. Home Assistant) that constantly re-render such
// controls - now also visible inside shadow DOM - from thrashing the scanner.
export const INTERESTING_NODES = [
    "form",
    'input[type="password"]',
    'input[type="text"]',
    'input[type="email"]',
    'input[type="tel"]',
    'input[type="url"]',
    'input[type="number"]',
    "input:not([type])"
];
const INTERESTING_NODES_SELECTOR = INTERESTING_NODES.join(",");

// A login form is often revealed by toggling an attribute on an existing
// (already-present) element - display:none removed, a "hidden" class dropped,
// the hidden attribute cleared, or a honeypot input's type flipped from
// "hidden" to "text"/"password" - rather than by adding new DOM nodes. Watch
// just these few attributes (not the unfiltered firehose) so such reveals
// trigger a rescan the same way a newly-added form does.
export const MUTATION_OBSERVER_OPTIONS: MutationObserverInit = {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["style", "class", "hidden", "type"]
};

// Did something get added or removed? Then the cached list of open shadow
// roots can no longer be trusted
export function isStructural(mutations: MutationRecord[]): boolean {
    return mutations.some(
        m => m.type === "childList" && (m.addedNodes.length > 0 || m.removedNodes.length > 0)
    );
}

// Could any of these changes have brought a login form or field into view?
// Stops at the first one that could.
export function wantsRescan(
    mutations: MutationRecord[],
    formUtils: Pick<FormUtils, "deepContains">
): boolean {
    return mutations.some(mutation => {
        if (mutation.type === "childList") {
            for (const node of Array.from(mutation.addedNodes)) {
                const element = node as Element;
                if (typeof element.querySelector !== "function") continue;
                // deepContains also looks inside any open shadow roots the added
                // subtree carries, so web-component forms trigger a rescan too.
                if (
                    element.matches?.(INTERESTING_NODES_SELECTOR) ||
                    formUtils.deepContains(element, INTERESTING_NODES)
                ) {
                    return true;
                }
            }
            return false;
        }
        if (mutation.type !== "attributes") return false;
        // A style/class/hidden/type change on an existing element - either the
        // form/field itself, or a wrapper that was hiding it - can reveal a login
        // form without adding any DOM nodes. Treat that the same as a newly-added
        // node.
        const element = mutation.target as Element;
        if (element.matches?.(INTERESTING_NODES_SELECTOR)) return true;
        // <html>/<body> themselves are an extremely common target for unrelated
        // attribute churn (theme toggles, scroll-lock classes, app-root re-render
        // markers) and, being the mutated element, would make deepContains search
        // the entire page on every such toggle. A form is essentially never
        // revealed by an attribute directly on <html>/<body> - it's some more
        // specific wrapper further down that gets its own mutation record - so
        // skip the expensive whole-page search for exactly these two elements.
        const doc = element.ownerDocument;
        if (element === doc?.documentElement || element === doc?.body) return false;
        return (
            typeof element.querySelector === "function" &&
            formUtils.deepContains(element, INTERESTING_NODES)
        );
    });
}

// A page that keeps mutating (SPA dashboards) should not trigger a form scan +
// KeePassRPC round-trip every half second forever: the wait doubles every 8
// rescans up to a cap, and after too many we stop watching altogether.
export class RescanBackoff {
    public static readonly MIN_MS = 500;
    public static readonly MAX_MS = 5000;
    public static readonly PER_STEP = 8;
    // Give up observing on pathologically chatty pages
    public static readonly HARD_LIMIT = 250;

    private count = 0;

    // A new page (incl. a bfcache restore) starts over
    public reset() {
        this.count = 0;
    }

    // How long to wait before the next rescan; null once the page has had
    // too many and should no longer be watched
    public next(): number | null {
        this.count++;
        if (this.count > RescanBackoff.HARD_LIMIT) return null;
        return Math.min(
            RescanBackoff.MIN_MS * 2 ** Math.floor(this.count / RescanBackoff.PER_STEP),
            RescanBackoff.MAX_MS
        );
    }
}
