// @vitest-environment jsdom
//
// KeeFieldIcon places an overlay icon over matched fields. jsdom does no
// layout, so field geometry and hit-testing (elementsFromPoint) are stubbed.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KeeFieldIcon } from "../page/keeFieldIcon";
import { FormUtils } from "../page/formsUtils";
import { MatchedField } from "../page/MatchedField";
import { Entry } from "../common/model/Entry";
import { Action } from "../common/Action";

const RECT = { left: 100, top: 50, right: 300, bottom: 80, width: 200, height: 30, x: 100, y: 50 };

function makeInput(id: string, type = "text") {
    const input = document.createElement("input");
    input.id = id;
    input.type = type;
    input.style.setProperty("box-sizing", "border-box");
    input.style.setProperty("padding-left", "2px");
    Object.defineProperty(input, "offsetWidth", { value: RECT.width });
    input.getBoundingClientRect = () => ({ ...rect, toJSON: () => ({}) }) as DOMRect;
    document.body.appendChild(input);
    return input;
}

function matched(input: HTMLInputElement): MatchedField {
    return { field: { type: input.type }, DOMelement: input, highestScore: 1 } as MatchedField;
}

// Current geometry of every test input
let rect = RECT;

// What sits on top at each x position (anything not listed is the input itself)
let coveredAt: Map<number, Element>;

function setup(parentFrameId = 0) {
    const port = { postMessage: vi.fn() } as unknown as chrome.runtime.Port;
    const openPanel = vi.fn();
    const formUtils = {
        isATextFormFieldType: (t: string) => t === "text" || t === "email"
    } as unknown as FormUtils;
    const icon = new KeeFieldIcon(port, parentFrameId, formUtils, openPanel);
    created.push(icon);
    return { icon, port, openPanel };
}

const created: KeeFieldIcon[] = [];

function overlays() {
    return Array.from(document.body.querySelectorAll("div"));
}

beforeEach(() => {
    document.body.innerHTML = "";
    coveredAt = new Map();
    rect = RECT;
    // Run animation-frame callbacks straight away
    vi.stubGlobal(
        "requestAnimationFrame",
        vi.fn((cb: FrameRequestCallback) => {
            cb(0);
            return 1;
        })
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    (document as unknown as { elementsFromPoint: unknown }).elementsFromPoint = (
        x: number
    ) => {
        const input = document.querySelector("input");
        const cover = coveredAt.get(x);
        return cover ? [cover, input] : [input];
    };
});

afterEach(() => {
    for (const icon of created.splice(0)) icon.removeKeeIconFromAllFields();
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

const LEFT_SPOT = RECT.left + 0 + 8;
const ONE_ENTRY = [{}] as Entry[];

describe("KeeFieldIcon", () => {
    it("places the icon on the left and makes room for the text", () => {
        const { icon } = setup();
        const user = makeInput("user");
        icon.addKeeIconToFields([], [matched(user)], ONE_ENTRY);

        const hosts = overlays();
        expect(hosts).toHaveLength(1);
        expect(hosts[0].style.getPropertyValue("--keelink-icon-left")).toBe(RECT.left + 0 + "px");
        expect(user.style.paddingLeft).toBe("20px");
        expect(user.style.getPropertyPriority("padding-left")).toBe("important");
    });

    it("falls back to the right when the site covers the left edge", () => {
        const { icon } = setup();
        const user = makeInput("user");
        coveredAt.set(LEFT_SPOT, document.createElement("span"));
        icon.addKeeIconToFields([], [matched(user)], ONE_ENTRY);

        expect(overlays()[0].style.getPropertyValue("--keelink-icon-left")).toBe(RECT.right - 0 - 16 + "px");
        expect(user.style.paddingLeft).toBe("2px");
    });

    it("indents instead of padding content-box fields", () => {
        const { icon } = setup();
        const user = makeInput("user");
        user.style.setProperty("box-sizing", "content-box");
        icon.addKeeIconToFields([], [matched(user)], ONE_ENTRY);

        expect(user.style.paddingLeft).toBe("2px");
        expect(user.style.textIndent).toBe("18px");
    });

    it("restores the field and removes the overlay", () => {
        const { icon } = setup();
        const user = makeInput("user");
        icon.addKeeIconToFields([], [matched(user)], ONE_ENTRY);
        icon.removeKeeIconFromAllFields();

        expect(overlays()).toHaveLength(0);
        expect(user.style.paddingLeft).toBe("2px");
        expect(user.style.getPropertyPriority("padding-left")).toBe("");
    });

    it("tells its own style changes apart from the site's", async () => {
        const { icon } = setup();
        const user = makeInput("user");
        const records: MutationRecord[] = [];
        const observer = new MutationObserver(m => records.push(...m));
        observer.observe(document.body, { subtree: true, attributes: true, attributeFilter: ["style"] });
        const flush = () => new Promise(r => setTimeout(r, 0));

        icon.addKeeIconToFields([], [matched(user)], ONE_ENTRY);
        icon.addKeeIconToFields([], [matched(user)], ONE_ENTRY);
        icon.removeKeeIconFromAllFields();
        await flush();
        const ours = records.splice(0).filter(r => r.target === user);
        expect(ours.length).toBeGreaterThan(0);
        expect(ours.every(r => icon.isOwnMutation(r))).toBe(true);

        user.style.setProperty("display", "none");
        await flush();
        observer.disconnect();
        expect(records.filter(r => r.target === user).some(r => icon.isOwnMutation(r))).toBe(false);
    });

    it("counts adding, moving and removing its icons as its own changes", async () => {
        const { icon } = setup();
        const user = makeInput("user");
        const records: MutationRecord[] = [];
        const observer = new MutationObserver(m => records.push(...m));
        observer.observe(document.body, {
            subtree: true,
            childList: true,
            attributes: true,
            attributeFilter: ["style", "class"]
        });
        const flush = () => new Promise(r => setTimeout(r, 0));

        icon.addKeeIconToFields([], [matched(user)], ONE_ENTRY);
        rect = { ...RECT, left: 150, right: 350 };
        window.dispatchEvent(new Event("scroll"));
        icon.removeKeeIconFromAllFields();
        await flush();
        expect(records.some(r => r.type === "childList")).toBe(true);
        expect(records.every(r => icon.isOwnMutation(r))).toBe(true);

        // The site's own nodes still count
        document.body.appendChild(document.createElement("form"));
        await flush();
        observer.disconnect();
        expect(icon.isOwnMutation(records[records.length - 1])).toBe(false);
    });

    it("leaves the icon alone while the page scrolls", () => {
        const { icon } = setup();
        const user = makeInput("user");
        icon.addKeeIconToFields([], [matched(user)], ONE_ENTRY);
        const host = overlays()[0];
        const set = vi.spyOn(host.style, "setProperty");

        // The field moves up in the window by exactly as far as the page scrolled
        vi.stubGlobal("scrollY", 40);
        rect = { ...RECT, top: RECT.top - 40, bottom: RECT.bottom - 40 };
        window.dispatchEvent(new Event("scroll"));

        expect(set).not.toHaveBeenCalled();
        expect(host.style.getPropertyValue("--keelink-icon-top")).toBe(RECT.top + (30 - 16) / 2 + "px");
    });

    it("does not stack icons when called again", () => {
        const { icon } = setup();
        const user = makeInput("user");
        icon.addKeeIconToFields([], [matched(user)], ONE_ENTRY);
        icon.addKeeIconToFields([], [matched(user)], ONE_ENTRY);

        expect(overlays()).toHaveLength(1);
        expect(user.style.paddingLeft).toBe("20px");
    });

    it("follows the field when the page scrolls", () => {
        const { icon } = setup();
        const user = makeInput("user");
        icon.addKeeIconToFields([], [matched(user)], ONE_ENTRY);

        rect = { ...RECT, top: 10, bottom: 40 };
        window.dispatchEvent(new Event("scroll"));

        expect(overlays()[0].style.getPropertyValue("--keelink-icon-top")).toBe(10 + (30 - 16) / 2 + "px");
    });

    it("catches layout shifts via the fallback timer", () => {
        vi.useFakeTimers();
        const { icon } = setup();
        const user = makeInput("user");
        icon.addKeeIconToFields([], [matched(user)], ONE_ENTRY);

        rect = { ...RECT, left: 150, right: 350 };
        vi.advanceTimersByTime(500);

        expect(overlays()[0].style.getPropertyValue("--keelink-icon-left")).toBe(150 + 0 + "px");
    });

    it("stops tracking once the icons are removed", () => {
        vi.useFakeTimers();
        const { icon } = setup();
        const user = makeInput("user");
        icon.addKeeIconToFields([], [matched(user)], ONE_ENTRY);
        icon.removeKeeIconFromAllFields();

        expect(vi.getTimerCount()).toBe(0);
    });

    it("opens the panel next to the field with the icon's side", () => {
        const { icon, openPanel } = setup();
        const user = makeInput("user");
        icon.addKeeIconToFields([], [matched(user)], ONE_ENTRY);
        overlays()[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));

        expect(openPanel).toHaveBeenCalledWith(user, "left");
    });

    it("asks the top frame to show the panel when in a subframe", () => {
        const { icon, port, openPanel } = setup(5);
        const user = makeInput("user");
        icon.addKeeIconToFields([], [matched(user)], ONE_ENTRY);
        overlays()[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));

        expect(openPanel).not.toHaveBeenCalled();
        expect(port.postMessage).toHaveBeenCalledWith({ action: Action.ShowMatchedLoginsPanel });
    });
});
