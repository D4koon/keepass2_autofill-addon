// KeeFieldIcon in a real browser (Chromium and Firefox): real layout, real CSS
// cascade and real hit-testing, none of which jsdom does. Each test builds a
// small page reproducing a layout found on real login pages and checks where
// the icon actually ends up and that it is the topmost thing at that spot.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KeeFieldIcon } from "../../page/keeFieldIcon";
import { FormUtils } from "../../page/formsUtils";
import { MatchedField } from "../../page/MatchedField";
import { Entry } from "../../common/model/Entry";
import { PanelStub, PanelStubOptions } from "../../page/PanelStub";

const ICON_SIZE = 16;
const ICON_INSET = 0;
const TEXT_START = ICON_INSET + ICON_SIZE + 4;
const ONE_ENTRY = [{}] as Entry[];

const created: KeeFieldIcon[] = [];

function setup() {
    const port = { postMessage: vi.fn() } as unknown as chrome.runtime.Port;
    const openPanel = vi.fn();
    const formUtils = {
        isATextFormFieldType: (t: string) => t === "text" || t === "email"
    } as unknown as FormUtils;
    const icon = new KeeFieldIcon(port, 0, formUtils, openPanel);
    created.push(icon);
    return { icon, openPanel };
}

function matched(input: HTMLInputElement): MatchedField {
    return { field: { type: input.type }, DOMelement: input, highestScore: 1 } as MatchedField;
}

// Builds the page; returns the input with id "field"
function page(html: string, css = "") {
    document.head.querySelector("style#fixture")?.remove();
    const style = document.createElement("style");
    style.id = "fixture";
    style.textContent = css;
    document.head.appendChild(style);
    document.body.innerHTML = html;
    return document.getElementById("field") as HTMLInputElement;
}

function show(input: HTMLInputElement) {
    const { icon, openPanel } = setup();
    icon.addKeeIconToFields([], [matched(input)], ONE_ENTRY);
    return { icon, openPanel, host: hosts()[0] };
}

// Our icon hosts are the only elements with a shadow root we can't see into
function hosts() {
    return Array.from(document.querySelectorAll("div")).filter(
        d => d.shadowRoot === null && d.title === "matched_logins_label"
    );
}

const frames = (n = 2) =>
    new Promise<void>(resolve => {
        const step = () => (--n <= 0 ? resolve() : requestAnimationFrame(step));
        requestAnimationFrame(step);
    });

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function expectIconAt(host: HTMLElement, input: HTMLElement, side: "left" | "right") {
    const r = input.getBoundingClientRect();
    const h = host.getBoundingClientRect();
    expect(h.width).toBe(ICON_SIZE);
    expect(h.height).toBe(ICON_SIZE);
    const x = side === "left" ? r.left + ICON_INSET : r.right - ICON_INSET - ICON_SIZE;
    expect(h.left).toBeCloseTo(x, 0);
    expect(h.top).toBeCloseTo(r.top + (r.height - ICON_SIZE) / 2, 0);
}

// The icon is what the user would actually hit when clicking its centre
function expectIconOnTop(host: HTMLElement) {
    const h = host.getBoundingClientRect();
    expect(document.elementFromPoint(h.left + h.width / 2, h.top + h.height / 2)).toBe(host);
}

const FIELD = "<input id=\"field\" type=\"text\" style=\"width: 300px; height: 40px; box-sizing: border-box; padding: 0 8px\">";

beforeEach(() => {
    window.scrollTo(0, 0);
});

afterEach(() => {
    for (const icon of created.splice(0)) icon.removeKeeIconFromAllFields();
    document.body.removeAttribute("style");
    document.body.innerHTML = "";
    document.head.querySelector("style#fixture")?.remove();
});

describe("KeeFieldIcon in a real browser", () => {
    it("sits on the left edge of a plain field and moves the text out of its way", () => {
        const input = page(`<form style="margin: 100px">${FIELD}</form>`);
        const { host } = show(input);

        expectIconAt(host, input, "left");
        expectIconOnTop(host);
        expect(parseFloat(getComputedStyle(input).paddingLeft)).toBe(TEXT_START);
    });

    it("indents the text of content-box fields instead of widening them", () => {
        const input = page(
            "<form style=\"margin: 100px\"><input id=\"field\" type=\"text\" style=\"width: 300px; box-sizing: content-box; padding: 4px\"></form>"
        );
        const width = input.getBoundingClientRect().width;
        const { host } = show(input);

        expectIconAt(host, input, "left");
        expect(input.getBoundingClientRect().width).toBe(width);
        expect(parseFloat(getComputedStyle(input).textIndent)).toBe(TEXT_START - 4);
    });

    it("puts the field back as it was when the icon is removed", () => {
        const input = page(`<form style="margin: 100px">${FIELD}</form>`);
        const { icon } = show(input);
        icon.removeKeeIconFromAllFields();

        expect(hosts()).toHaveLength(0);
        expect(getComputedStyle(input).paddingLeft).toBe("8px");
    });

    it("ignores a floating label that lets clicks through (auth.gmx.net)", () => {
        const input = page(
            `<div style="margin: 100px"><span class="floating">
                <label for="field">E-Mail</label>${FIELD}
            </span></div>`,
            `.floating { position: relative; display: inline-flex; }
             .floating label { position: absolute; left: 8px; right: 8px; top: 0;
                 line-height: 40px; z-index: 1; pointer-events: none; }`
        );
        const { host } = show(input);

        expectIconAt(host, input, "left");
        expectIconOnTop(host);
    });

    it("moves to the right when the site shows a button on the left of the field", () => {
        const input = page(
            `<div style="margin: 100px; position: relative; display: inline-block">
                ${FIELD}<button style="position: absolute; left: 2px; top: 5px; width: 30px; height: 30px">x</button>
            </div>`
        );
        const { host } = show(input);

        expectIconAt(host, input, "right");
        expectIconOnTop(host);
        expect(getComputedStyle(input).paddingLeft).toBe("8px");
    });

    it("stays left and on top when both edges are covered", () => {
        const input = page(
            `<div style="margin: 100px; position: relative; display: inline-block">
                ${FIELD}
                <span style="position: absolute; left: 0; top: 0; width: 40px; height: 40px"></span>
                <span style="position: absolute; right: 0; top: 0; width: 40px; height: 40px"></span>
            </div>`
        );
        const { host } = show(input);

        expectIconAt(host, input, "left");
        expectIconOnTop(host);
    });

    // Like <lux-password> on auth.gmx.net: the custom element draws the field
    // (border, padding, room for a floating label) and the real input sits inset
    // inside its shadow root
    function defineFieldComponent(name: string, formAssociated: boolean) {
        if (customElements.get(name)) return;
        customElements.define(
            name,
            class extends HTMLElement {
                static formAssociated = formAssociated;
                constructor() {
                    super();
                    if (formAssociated) this.attachInternals();
                    this.attachShadow({ mode: "open", delegatesFocus: true }).innerHTML =
                        "<style>:host { display: inline-flex; box-sizing: border-box; width: 300px;" +
                        " height: 48px; padding: 20px 16px 4px; border: 1px solid }" +
                        " input { flex-grow: 1; min-width: 0; height: 22px; border: 0; padding: 0 }</style>" +
                        "<input class=\"input\" part=\"input\" type=\"password\">";
                }
            }
        );
    }

    it("sits on the box of a form-associated web component field (auth.gmx.net)", () => {
        defineFieldComponent("test-password", true);
        page("<form style=\"margin: 100px\"><test-password></test-password></form>");
        const box = document.querySelector<HTMLElement>("test-password");
        const input = box.shadowRoot.querySelector("input");
        const { host } = show(input);

        expectIconAt(host, box, "left");
        expectIconOnTop(host);
        // The room for the icon is made in the box, so the typed text moves too
        expect(parseFloat(getComputedStyle(box).paddingLeft)).toBe(TEXT_START);
        expect(input.getBoundingClientRect().left).toBeGreaterThanOrEqual(
            host.getBoundingClientRect().right
        );
    });

    it("moves a floating label laid over the field out from under the icon (auth.gmx.net)", () => {
        defineFieldComponent("test-password", true);
        page(
            "<form style=\"margin: 100px\"><span class=\"floating\">" +
                "<test-password id=\"input-password\"></test-password>" +
                "<label for=\"input-password\">Passwort</label></span></form>",
            ".floating { display: inline-flex; position: relative }" +
                " .floating label { position: absolute; top: 4px; left: 16px; right: 16px;" +
                " line-height: 40px; pointer-events: none; overflow: hidden; white-space: nowrap }"
        );
        const box = document.querySelector<HTMLElement>("test-password");
        const label = document.querySelector("label");
        const { icon, host } = show(box.shadowRoot.querySelector("input"));

        expectIconAt(host, box, "left");
        expect(label.getBoundingClientRect().left).toBeGreaterThanOrEqual(
            host.getBoundingClientRect().right
        );
        // Still ends where it did, so it doesn't stick out past the field
        expect(label.getBoundingClientRect().right).toBe(box.getBoundingClientRect().right - 16);

        icon.removeKeeIconFromAllFields();
        expect(label.getBoundingClientRect().left).toBe(box.getBoundingClientRect().left + 16);
    });

    it("moves a floating label whose for= doesn't match the field (auth.gmx.net email)", () => {
        page(
            "<form style=\"margin: 100px\"><span class=\"floating\">" +
                "<label for=\"username\">E-Mail</label>" +
                "<input id=\"field\" type=\"email\" readonly value=\"b@example.com\"" +
                " style=\"width: 300px; height: 48px; box-sizing: border-box; padding: 20px 16px 4px\">" +
                "</span></form>",
            ".floating { display: inline-flex; position: relative }" +
                " .floating label { position: absolute; top: 4px; left: 16px; right: 16px; pointer-events: none }"
        );
        const input = document.getElementById("field") as HTMLInputElement;
        const label = document.querySelector("label");
        const { host } = show(input);

        expect(label.getBoundingClientRect().left).toBeGreaterThanOrEqual(
            host.getBoundingClientRect().right
        );
        expect(label.getBoundingClientRect().left - input.getBoundingClientRect().left).toBe(TEXT_START);
    });

    it("keeps an animated floating label clear of the icon when the icons are redrawn", async () => {
        page(
            "<form style=\"margin: 100px\"><span class=\"floating\">" +
                "<label for=\"field\">Passwort</label>" +
                "<input id=\"field\" type=\"text\" style=\"width: 300px; height: 48px; box-sizing: border-box; padding: 20px 16px 4px\">" +
                "</span></form>",
            ".floating { display: inline-flex; position: relative }" +
                " .floating label { position: absolute; top: 4px; left: 16px; right: 16px; line-height: 40px;" +
                " pointer-events: none; transition: all .1s ease-in-out }"
        );
        const input = document.getElementById("field") as HTMLInputElement;
        const label = document.querySelector("label");
        const { icon } = show(input);
        await wait(300);

        // What every rescan does: take the icons down and put them straight back
        icon.addKeeIconToFields([], [matched(input)], ONE_ENTRY);
        await wait(300);
        expect(label.getBoundingClientRect().left - input.getBoundingClientRect().left).toBe(TEXT_START);
    });

    it("leaves a label above the field alone", () => {
        const input = page(
            `<form style="margin: 100px"><label for="field" style="display: block">User</label>${FIELD}</form>`
        );
        const label = document.querySelector("label");
        const before = label.getBoundingClientRect().left;
        show(input);
        expect(label.getBoundingClientRect().left).toBe(before);
        expect(label.style.marginLeft).toBe("");
    });

    it("sits on the input itself inside a web component that is no form control", () => {
        defineFieldComponent("test-wrapper", false);
        page("<form style=\"margin: 100px\"><test-wrapper></test-wrapper></form>");
        const input = document.querySelector("test-wrapper").shadowRoot.querySelector("input");
        const { host } = show(input);

        expectIconAt(host, input, "left");
    });

    it("follows the field when the window scrolls", async () => {
        const input = page(`<div style="height: 400px"></div>${FIELD}<div style="height: 2000px"></div>`);
        const { host } = show(input);

        window.scrollTo(0, 300);
        await frames();

        expectIconAt(host, input, "left");
        expectIconOnTop(host);
    });

    it("follows the field inside an inner scroll container (auth.gmx.net)", async () => {
        const input = page(
            `<div id="scroller" style="height: 100vh; overflow: hidden auto">
                <div style="height: 400px"></div>${FIELD}<div style="height: 2000px"></div>
            </div>`
        );
        document.body.style.margin = "0";
        const { host } = show(input);

        document.getElementById("scroller").scrollTop = 300;
        await frames();

        expectIconAt(host, input, "left");
        expectIconOnTop(host);
    });

    it("follows the field when it moves without any scroll or resize event", async () => {
        const input = page(`<div id="banner"></div><form style="margin: 50px">${FIELD}</form>`);
        const { host } = show(input);

        document.getElementById("banner").style.height = "120px";
        await wait(600); // fallback timer

        expectIconAt(host, input, "left");
    });

    it("follows the field when it is resized", async () => {
        const input = page(
            `<form style="margin: 100px; text-align: right; width: 600px">${FIELD}</form>`
        );
        const { host } = show(input);

        input.style.width = "200px";
        await frames(3);

        expectIconAt(host, input, "left");
    });

    it("hides while the field is hidden and comes back with it", async () => {
        const input = page(`<form style="margin: 100px">${FIELD}</form>`);
        const { host } = show(input);

        input.style.display = "none";
        await wait(600);
        expect(host.getBoundingClientRect().width).toBe(0);

        input.style.display = "";
        await wait(600);
        expectIconAt(host, input, "left");
    });

    it("lines up with fields inside transformed containers", () => {
        const input = page(
            `<div style="margin: 100px; transform: translate(40px, 30px) scale(1.1)">${FIELD}</div>`
        );
        const { host } = show(input);

        const r = input.getBoundingClientRect();
        const h = host.getBoundingClientRect();
        expect(h.left).toBeCloseTo(r.left + ICON_INSET, 0);
        expect(h.top).toBeCloseTo(r.top + (r.height - ICON_SIZE) / 2, 0);
        expectIconOnTop(host);
    });

    it("isn't broken by aggressive site CSS", () => {
        const input = page(
            `<form style="margin: 100px">${FIELD}</form>`,
            `div { display: none !important; position: static !important; left: 0 !important;
                   top: 0 !important; width: 0 !important; opacity: 0 !important; }
             body > * { visibility: hidden !important; }
             form, input { visibility: visible !important; }
             img { display: none !important; }`
        );
        const { host } = show(input);

        expectIconAt(host, input, "left");
        expectIconOnTop(host);
        expect(getComputedStyle(host).opacity).toBe("1");
        expect(getComputedStyle(host).visibility).toBe("visible");
    });

    it("stays on top of site elements with the highest z-index", () => {
        const input = page(
            `<form style="margin: 100px; position: relative; z-index: 2147483647">${FIELD}</form>`
        );
        const { host } = show(input);

        expectIconOnTop(host);
    });

    it("opens the panel when clicked, on the icon's side", () => {
        const input = page(`<form style="margin: 100px">${FIELD}</form>`);
        const { host, openPanel } = show(input);

        const h = host.getBoundingClientRect();
        const target = document.elementFromPoint(h.left + 8, h.top + 8) as HTMLElement;
        target.click();

        expect(openPanel).toHaveBeenCalledWith(input, "left");
    });

    it("keeps focus in the field when the icon is pressed", () => {
        const input = page(`<form style="margin: 100px">${FIELD}</form>`);
        const { host } = show(input);
        input.focus();

        const pressed = host.dispatchEvent(
            new MouseEvent("mousedown", { bubbles: true, cancelable: true })
        );

        expect(pressed).toBe(false); // default (moving focus) prevented
        expect(document.activeElement).toBe(input);
    });

    it("clears away the icons an earlier copy of the content script left behind", () => {
        // e.g. the add-on was reloaded: the old copy is gone, its icons are not
        const input = page(`<form style="margin: 100px">${FIELD}</form>`);
        show(input);
        const { host } = show(input);

        expect(hosts()).toEqual([host]);
        expectIconAt(host, input, "left");
    });

    it("lines up when the body is positioned and has a margin", () => {
        const input = page(`<form style="margin: 100px">${FIELD}</form>`);
        document.body.style.cssText = "position: relative; margin: 40px";
        const { host } = show(input);

        expectIconAt(host, input, "left");
    });

    it("comes back when the site removes it from the page", async () => {
        const input = page(`<form style="margin: 100px">${FIELD}</form>`);
        const { host } = show(input);

        host.remove(); // e.g. a framework clearing everything it doesn't own from <body>
        await wait(600);

        const now = hosts();
        expect(now).toHaveLength(1);
        expectIconAt(now[0], input, "left");
    });

    it("gives up after the site removed it a few times", async () => {
        const input = page(`<form style="margin: 100px">${FIELD}</form>`);
        show(input);

        for (let i = 0; i < 4; i++) {
            hosts()[0].remove();
            await wait(600);
        }

        expect(hosts()).toHaveLength(0);
    });
});

// A modal <dialog> or an open popover is in the browser's top layer: above any
// z-index, and a modal dialog makes the rest of the page inert
describe("KeeFieldIcon and the top layer", () => {
    function modal(html: string, css = "") {
        page(`<dialog id="dlg">${html}</dialog>`, css);
        const dialog = document.getElementById("dlg") as HTMLDialogElement;
        dialog.showModal();
        return dialog;
    }

    afterEach(() => {
        for (const d of Array.from(document.querySelectorAll("dialog"))) d.close();
    });

    it("shows above a modal dialog that contains the field, and can be clicked", () => {
        modal(FIELD);
        const input = document.getElementById("field") as HTMLInputElement;
        const { host, openPanel } = show(input);

        expectIconAt(host, input, "left");
        expectIconOnTop(host);
        const h = host.getBoundingClientRect();
        document.elementFromPoint(h.left + 8, h.top + 8)!.dispatchEvent(
            new MouseEvent("click", { bubbles: true, cancelable: true })
        );
        expect(openPanel).toHaveBeenCalled();
    });

    it("isn't cut off by a small dialog that clips its contents", () => {
        // The field reaches past the dialog's edge, which hides what overflows
        modal(
            "<div style=\"margin-left: -20px\">" + FIELD + "</div>",
            "#dlg { width: 200px; overflow: hidden; padding: 0 }"
        );
        const input = document.getElementById("field") as HTMLInputElement;
        const { host } = show(input);

        expectIconAt(host, input, "left");
        expectIconOnTop(host);
    });

    it("goes back into the page when the dialog closes, and returns with it", async () => {
        const dialog = modal(FIELD);
        const input = document.getElementById("field") as HTMLInputElement;
        const { host } = show(input);

        dialog.close();
        await wait(600);
        expect(host.parentElement).toBe(document.body);
        expect(host.hasAttribute("popover")).toBe(false);

        dialog.showModal();
        await wait(600);
        expect(hosts()).toEqual([host]);
        expectIconAt(host, input, "left");
        expectIconOnTop(host);
    });

    it("follows the field when the dialog's content scrolls", async () => {
        const dialog = modal(
            `<div style="height: 300px"></div>${FIELD}<div style="height: 600px"></div>`,
            "#dlg { height: 300px; overflow: auto }"
        );
        const input = document.getElementById("field") as HTMLInputElement;
        const { host } = show(input);

        dialog.scrollTop = 200;
        await frames();
        expectIconAt(host, input, "left");
        expectIconOnTop(host);
    });

    it("shows above an open popover that contains the field", () => {
        page(`<div id="pop" popover>${FIELD}</div>`);
        document.getElementById("pop")!.showPopover();
        const input = document.getElementById("field") as HTMLInputElement;
        const { host } = show(input);

        expectIconAt(host, input, "left");
        expectIconOnTop(host);
        document.getElementById("pop")!.hidePopover();
    });

    it("stays a plain element in <body> when there is no dialog", () => {
        const input = page(`<form style="margin: 100px">${FIELD}</form>`);
        const { host } = show(input);

        expect(host.parentElement).toBe(document.body);
        expect(host.hasAttribute("popover")).toBe(false);
    });

    it("opens the panel above the dialog, under the field, and closes it with the dialog", async () => {
        const dialog = modal(FIELD);
        const input = document.getElementById("field") as HTMLInputElement;
        const stub = new PanelStub(PanelStubOptions.MatchedLogins, input, 0, "left");
        stub.createPanel();

        const panel = document.getElementById(PanelStubOptions.MatchedLogins.id)!;
        const p = panel.getBoundingClientRect();
        const r = input.getBoundingClientRect();
        expect(p.top).toBeCloseTo(r.bottom, 0);
        expect(p.left).toBeCloseTo(r.left, 0);
        expect(document.elementFromPoint(p.left + p.width / 2, p.top + p.height / 2)).toBe(panel);

        dialog.close();
        await wait(50); // "close" fires after close() returns
        expect(panel.isConnected).toBe(false);
    });
});
