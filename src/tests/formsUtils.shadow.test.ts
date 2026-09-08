// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
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
