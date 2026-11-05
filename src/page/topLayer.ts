// A modal <dialog> (showModal) or an open popover sits in the browser's top
// layer: above anything else, whatever its z-index, and a modal dialog makes
// the rest of the page inert (unclickable). Our icon and panels for a field in
// there have to join it: they go inside that element, so they aren't inert,
// and show as a popover of their own, so they are drawn above it and not
// clipped by its overflow.

// The innermost open modal dialog or popover `el` is in, also across shadow
// roots; null if none
export function topLayerAncestor(el: Element | null): HTMLElement | null {
    let node = el;
    while (node) {
        const found = closestTopLayer(node);
        if (found) return found;
        const root = node.getRootNode();
        node = root instanceof ShadowRoot ? root.host : null;
    }
    return null;
}

// By hand rather than closest("dialog:modal, :popover-open"): only an open
// <dialog> or an element with a popover attribute can match, and asking just
// those is cheaper (jsdom takes seconds over :modal)
function closestTopLayer(el: Element): HTMLElement | null {
    for (let node: Element = el; node; node = node.parentElement) {
        if (node instanceof HTMLDialogElement && node.open && matches(node, ":modal")) {
            return node;
        }
        if (node.hasAttribute("popover") && matches(node, ":popover-open")) {
            return node as HTMLElement;
        }
    }
    return null;
}

function matches(el: Element, selector: string) {
    try {
        return el.matches(selector);
    } catch {
        // A browser that doesn't know the selector
        return false;
    }
}

// Show `el` (already in the document) above everything as a manual popover:
// one the browser never closes by itself and that leaves the site's own
// popovers open
export function showInTopLayer(el: HTMLElement) {
    if (typeof el.showPopover !== "function") return;
    el.setAttribute("popover", "manual");
    try {
        if (!el.matches(":popover-open")) el.showPopover();
    } catch {
        // Not connected, or the browser refused; it stays a normal element
    }
}

export function leaveTopLayer(el: HTMLElement) {
    if (!el.hasAttribute("popover")) return;
    try {
        el.hidePopover();
    } catch {
        // Wasn't showing
    }
    el.removeAttribute("popover");
}
