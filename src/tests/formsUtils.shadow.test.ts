// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FormUtils } from "../page/formsUtils";

const logger = { debug() {}, info() {}, warn() {}, error() {} };

function fu() {
    return new FormUtils(logger as never);
}

beforeEach(() => {
    document.body.innerHTML = "";
});

// Attach an open shadow root to `host` and set its markup.
function shadow(host: Element, html: string): ShadowRoot {
    const sr = host.attachShadow({ mode: "open" });
    sr.innerHTML = html;
    return sr;
}

describe("FormUtils shadow-DOM traversal", () => {
    it("getOpenShadowRoots finds nested open roots and ignores closed ones", () => {
        document.body.innerHTML = "<div id=\"a\"></div><div id=\"b\"></div><div id=\"closed\"></div>";
        const a = document.getElementById("a")!;
        const b = document.getElementById("b")!;
        const aRoot = shadow(a, "<div id=\"inner\"></div>");
        shadow(aRoot.getElementById("inner") as Element, "<span></span>");
        shadow(b, "<span></span>");
        document.getElementById("closed")!.attachShadow({ mode: "closed" });

        const roots = fu().getOpenShadowRoots(document);
        expect(roots.length).toBe(3); // a, a>inner, b  (closed one excluded)
    });

    it("deepQueryAll returns light-DOM and shadow-DOM matches together", () => {
        document.body.innerHTML = `
            <input id="light" type="text">
            <my-field></my-field>`;
        shadow(
            document.querySelector("my-field")!,
            "<input id=\"shadow1\" type=\"password\">"
        );

        const inputs = fu().deepQueryAll<HTMLInputElement>(document, "input");
        const ids = inputs.map(i => i.id).sort();
        expect(ids).toEqual(["light", "shadow1"]);
    });

    it("deepQueryAll pierces multiple nesting levels", () => {
        document.body.innerHTML = "<x-outer></x-outer>";
        const outer = shadow(document.querySelector("x-outer")!, "<x-inner></x-inner>");
        shadow(
            outer.querySelector("x-inner")!,
            "<input id=\"deep\" type=\"password\">"
        );
        expect(fu().deepQueryAll(document, 'input[type="password"]').length).toBe(1);
    });

    it("deepContains is true only when a selector matches somewhere in the tree", () => {
        document.body.innerHTML = "<x-host></x-host>";
        shadow(document.querySelector("x-host")!, "<input type=\"text\">");
        const u = fu();
        expect(u.deepContains(document.body, ['input[type="text"]'])).toBe(true);
        expect(u.deepContains(document.body, ['input[type="password"]', "form"])).toBe(
            false
        );
    });

    it("caches the shadow-root list until invalidateShadowCache is called", () => {
        document.body.innerHTML = "<x-a></x-a>";
        shadow(document.querySelector("x-a")!, "<div></div>");
        const u = fu();

        expect(u.getOpenShadowRoots(document).length).toBe(1);

        // A new host added without invalidation is not seen (stale cache is fine
        // here - the mutation observer invalidates on real DOM changes).
        document.body.insertAdjacentHTML("beforeend", "<x-b></x-b>");
        shadow(document.querySelector("x-b")!, "<div></div>");
        expect(u.getOpenShadowRoots(document).length).toBe(1);

        u.invalidateShadowCache();
        expect(u.getOpenShadowRoots(document).length).toBe(2);
    });

    it("keeps the page's cached list while the mutation observer checks other elements", () => {
        document.body.innerHTML = "<div id=\"changed\"><x-a></x-a></div><x-b></x-b>";
        shadow(document.querySelector("x-a")!, "<input type=\"text\">");
        shadow(document.querySelector("x-b")!, "<div></div>");
        const u = fu();
        const page = u.getOpenShadowRoots(document);

        expect(u.deepContains(document.getElementById("changed")!, ["input"])).toBe(true);

        expect(u.getOpenShadowRoots(document)).toBe(page);
        expect(u.getOpenShadowRoots(document.body)).toBe(page);
    });

    it("deepContains searches a subtree once for all selectors", () => {
        document.body.innerHTML = "<div id=\"changed\"><span></span></div>";
        const changed = document.getElementById("changed")!;
        const spy = vi.spyOn(changed, "querySelector");

        expect(fu().deepContains(changed, ["form", 'input[type="password"]', "input"])).toBe(false);

        expect(spy).toHaveBeenCalledTimes(1);
    });

    it("deepContains still works when one selector is unknown", () => {
        document.body.innerHTML = "<div id=\"changed\"><input></div>";

        expect(fu().deepContains(document.getElementById("changed")!, ["::nonsense(", "input"])).toBe(true);
    });

    it("deepContains takes the shadow roots from the page's fresh list instead of walking", () => {
        document.body.innerHTML =
            "<div id=\"changed\"><x-outer></x-outer></div><x-other></x-other>";
        const outer = shadow(document.querySelector("x-outer")!, "<x-inner></x-inner>");
        shadow(outer.querySelector("x-inner")!, "<input id=\"pass\" type=\"password\">");
        shadow(document.querySelector("x-other")!, "<input id=\"elsewhere\" type=\"text\">");
        const u = fu();
        u.getOpenShadowRoots(document);
        const changed = document.getElementById("changed")!;
        const walk = vi.spyOn(changed, "querySelectorAll");

        expect(u.deepContains(changed, ['input[type="password"]'])).toBe(true);
        // x-other's input is in the page's list but not under #changed
        expect(u.deepContains(changed, ['input[type="text"]'])).toBe(false);
        expect(walk).not.toHaveBeenCalled();
    });

    it("deepContains walks the subtree when the page's list is stale", () => {
        document.body.innerHTML = "<div id=\"changed\"></div>";
        const u = fu();
        u.getOpenShadowRoots(document);
        const changed = document.getElementById("changed")!;
        changed.innerHTML = "<x-new></x-new>";
        shadow(changed.querySelector("x-new")!, "<input type=\"password\">");
        u.invalidateShadowCache();

        expect(u.deepContains(changed, ['input[type="password"]'])).toBe(true);
    });

    it("finds shadow inputs of a form, also in nested shadow roots, via the page's list", () => {
        document.body.innerHTML =
            "<form id=\"f\"><input id=\"user\"><x-outer></x-outer></form><x-other></x-other>";
        const outer = shadow(document.querySelector("x-outer")!, "<x-inner></x-inner>");
        shadow(outer.querySelector("x-inner")!, "<input id=\"pass\" type=\"password\">");
        shadow(document.querySelector("x-other")!, "<input id=\"elsewhere\">");

        const ids = fu()
            .getFormElements(document.getElementById("f"))
            .map(e => e.id);

        expect(ids).toEqual(["user", "pass"]);
    });

    it("observeOpenShadowRoots attaches the observer to each open root once", () => {
        document.body.innerHTML = "<x-a></x-a><x-b></x-b>";
        shadow(document.querySelector("x-a")!, "<div></div>");
        shadow(document.querySelector("x-b")!, "<div></div>");

        let observeCalls = 0;
        const fakeObserver = { observe: () => observeCalls++ } as unknown as MutationObserver;
        const u = fu();
        u.observeOpenShadowRoots(fakeObserver, document.body, { childList: true });
        u.observeOpenShadowRoots(fakeObserver, document.body, { childList: true });
        expect(observeCalls).toBe(2); // 2 roots, each observed exactly once
    });
});
