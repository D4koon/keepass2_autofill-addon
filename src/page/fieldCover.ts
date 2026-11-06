// Whether a field can be reached by the user, or whether something else on the
// page lies over it. Shared by the field icons (hidden when covered) and the
// fill (a covered field loses a tie, see fieldFilling.ts).

// Marks our icon hosts, so a fresh copy of the content script (after the add-on
// is reloaded or updated) can clear away the icons an earlier copy left behind
export const ICON_HOST_ATTR = "data-keelink-icon";

export function isIconHost(node: Node): boolean {
    return node instanceof Element && node.hasAttribute(ICON_HOST_ATTR);
}

// The element that draws the field. Usually the input itself, but a
// form-associated web component (e.g. <lux-password> on auth.gmx.net) is the
// form control as far as the page is concerned and draws the visible box, with
// the real input inset somewhere inside its shadow root.
export function fieldBox(input: HTMLElement): HTMLElement {
    let root = input.getRootNode();
    while (root instanceof ShadowRoot) {
        const host = root.host as HTMLElement;
        const form = host.closest("form");
        if (form && Array.prototype.includes.call(form.elements, host)) return host;
        root = host.getRootNode();
    }
    return input;
}

// The field and what is laid out around it: up to two wrappers up, short of
// <body>. Things in there that cover the field are the field's own.
export function fieldSurroundings(box: HTMLElement): Element {
    let near: Element = box;
    for (let i = 0; i < 2; i++) {
        const parent = near.parentElement;
        if (!parent || parent === document.body || parent === document.documentElement) break;
        near = parent;
    }
    return near;
}

// The topmost element at x/y in `root` that isn't one of our icons; null if it
// can't be told (off-screen, or no hit-testing as in jsdom)
export function siteElementAt(root: Node, x: number, y: number): Element | null {
    if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) return null;
    const r = root as Document | ShadowRoot;
    if (typeof r.elementsFromPoint !== "function") return null;
    return r.elementsFromPoint(x, y).find(e => !isIconHost(e)) ?? null;
}

// Does something from elsewhere on the page lie over the middle of the field,
// such as the mask behind a login window that covers the rest of the app? Then
// nobody can click or type into it. False when it can't be told.
export function isFieldCoveredBySite(input: HTMLElement): boolean {
    const box = fieldBox(input);
    const rect = box.getBoundingClientRect();
    if (!rect.width || !rect.height) return false;
    const top = siteElementAt(
        box.getRootNode(),
        rect.left + rect.width / 2,
        rect.top + rect.height / 2
    );
    if (!top || top === box || top === input) return false;
    return !fieldSurroundings(box).contains(top);
}
