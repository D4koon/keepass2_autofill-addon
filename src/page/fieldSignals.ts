// Cheap hints, from the DOM alone (no layout), about what a field is for and
// whether it belongs with the login: used to guess the username field and to
// settle ties when filling. They only ever reorder fields; an entry field whose
// stored name or id matches a page field still wins outright.

// The parent, stepping from a shadow root to its host
function parentAcrossShadow(node: Node): Node | null {
    const parent = node.parentNode;
    return parent instanceof ShadowRoot ? parent.host : parent;
}

const SEARCH_WORDS = /search|suche|recherche|buscar|cerca|zoek|szukaj/i;
const SEARCH_NAMES = ["q", "query", "s"];

// A site's search box rather than a login field
export function looksLikeSearchField(el: HTMLElement, labels: string[] = []): boolean {
    const input = el as HTMLInputElement;
    if (input.type === "search") return true;
    if (el.getAttribute("role") === "searchbox") return true;
    if (el.closest('[role="search"]')) return true;
    if (SEARCH_NAMES.includes((input.name || "").toLowerCase())) return true;
    return [
        input.name,
        el.id,
        el.getAttribute("placeholder"),
        el.getAttribute("aria-label"),
        ...labels
    ].some(v => !!v && SEARCH_WORDS.test(v));
}

// The site has switched the field off for the user: it, or something around
// it, is inert or hidden from assistive technology - as modal dialogs do to
// the rest of the page
export function isSwitchedOff(el: HTMLElement): boolean {
    for (let n: Node | null = el; n; n = parentAcrossShadow(n)) {
        if (!(n instanceof Element)) continue;
        if (n.hasAttribute("inert") || n.getAttribute("aria-hidden") === "true") return true;
    }
    return false;
}

// How far up from `b` its ancestry meets `a`'s: the fewer steps, the closer
// the two belong together. A username field meets its password field in the
// login box around them; the app's search box only near <body>.
export function stepsToMeet(a: Node, b: Node): number {
    const ancestorsOfA = new Set<Node>();
    for (let n: Node | null = a; n; n = parentAcrossShadow(n)) ancestorsOfA.add(n);
    let steps = 0;
    for (let n: Node | null = b; n; n = parentAcrossShadow(n), steps++) {
        if (ancestorsOfA.has(n)) return steps;
    }
    return Number.MAX_SAFE_INTEGER;
}
