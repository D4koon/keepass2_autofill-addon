// @vitest-environment jsdom
//
// What the content script's mutation observer (page.ts) makes of the changes
// busy pages keep making: which are worth a rescan, and how much searching it
// takes to tell. Counts searches rather than timing them, so it's stable in CI.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FormUtils } from "../page/formsUtils";
import {
    isStructural,
    MUTATION_OBSERVER_OPTIONS,
    RescanBackoff,
    wantsRescan
} from "../page/rescanTrigger";

const logger = { debug() {}, info() {}, warn() {}, error() {} };

let formUtils: FormUtils;

// The mutation records `change` produces, as the observer would get them
function recordsOf(change: () => void): MutationRecord[] {
    const observer = new MutationObserver(() => {});
    observer.observe(document.body, MUTATION_OBSERVER_OPTIONS);
    change();
    const records = observer.takeRecords();
    observer.disconnect();
    return records;
}

// As page.ts does it: a structural change drops the cached shadow roots first
function check(records: MutationRecord[]) {
    if (isStructural(records)) formUtils.invalidateShadowCache();
    return wantsRescan(records, formUtils);
}

// A big app wrapper with lots of content and no login fields
function bigWrapper(id = "app", count = 2000) {
    const wrapper = document.createElement("div");
    wrapper.id = id;
    for (let i = 0; i < count; i++) {
        const row = document.createElement("div");
        row.innerHTML = "<span>row</span><button>go</button>";
        wrapper.appendChild(row);
    }
    document.body.appendChild(wrapper);
    return wrapper;
}

beforeEach(() => {
    document.body.innerHTML = "";
    formUtils = new FormUtils(logger as never);
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe("which changes are worth a rescan", () => {
    it("ignores class toggles on a big wrapper without login fields, searching it once", () => {
        const wrapper = bigWrapper();
        // The last scan left the page's shadow-root list fresh
        formUtils.getOpenShadowRoots(document);
        const search = vi.spyOn(wrapper, "querySelector");
        const walk = vi.spyOn(wrapper, "querySelectorAll");

        const records = recordsOf(() => {
            wrapper.classList.toggle("hover");
            wrapper.classList.toggle("hover");
        });

        expect(check(records)).toBe(false);
        // Once per change, with all field types in one search
        expect(search).toHaveBeenCalledTimes(2);
        // and no listing of the wrapper to look for web components
        expect(walk).not.toHaveBeenCalled();
    });

    it("rescans when a wrapper hiding a login form is shown", () => {
        document.body.innerHTML =
            "<div id=\"login\" style=\"display:none\"><form><input type=\"password\"></form></div>";

        const records = recordsOf(() => {
            document.getElementById("login")!.style.display = "block";
        });

        expect(check(records)).toBe(true);
    });

    it("rescans when a login field inside a web component is shown", () => {
        document.body.innerHTML = "<div id=\"login\" hidden><x-login></x-login></div>";
        document
            .querySelector("x-login")!
            .attachShadow({ mode: "open" }).innerHTML = "<input type=\"email\">";
        formUtils.getOpenShadowRoots(document);

        const records = recordsOf(() => {
            document.getElementById("login")!.hidden = false;
        });

        expect(check(records)).toBe(true);
    });

    it("doesn't search the whole page for changes on <html> or <body>", () => {
        document.body.innerHTML = "<form><input type=\"password\"></form>";
        const search = vi.spyOn(document.body, "querySelector");

        const records = recordsOf(() => {
            document.documentElement.classList.add("dark");
            document.body.classList.add("scroll-lock");
        });

        expect(check(records)).toBe(false);
        expect(search).not.toHaveBeenCalled();
    });

    it("ignores re-rendered controls that never hold a login", () => {
        const panel = document.createElement("div");
        document.body.appendChild(panel);

        const records = recordsOf(() => {
            for (let i = 0; i < 20; i++) {
                panel.innerHTML = `
                    <input type="range" value="${i}">
                    <input type="checkbox">
                    <input type="radio">
                    <input type="hidden" value="${i}">
                    <input type="submit">
                    <select><option>a</option></select>
                    <button>ok</button>`;
            }
        });

        expect(records).toHaveLength(20);
        expect(check(records)).toBe(false);
    });

    it("ignores elements being removed", () => {
        document.body.innerHTML = "<form id=\"f\"><input type=\"password\"></form>";

        const records = recordsOf(() => document.getElementById("f")!.remove());

        expect(isStructural(records)).toBe(true);
        expect(check(records)).toBe(false);
    });

    it.each([
        ["a form", "<form></form>"],
        ["a password field in a wrapper", "<div><div><input type=\"password\"></div></div>"],
        ["a field without a type", "<input>"],
        ["an email field", "<input type=\"email\">"]
    ])("rescans when %s is added", (_, html) => {
        const records = recordsOf(() => document.body.insertAdjacentHTML("beforeend", html));

        expect(check(records)).toBe(true);
    });

    it("rescans when an added web component carries a login field", () => {
        const host = document.createElement("x-login");
        host.attachShadow({ mode: "open" }).innerHTML = "<input type=\"password\">";

        const records = recordsOf(() => document.body.appendChild(host));

        expect(check(records)).toBe(true);
    });

    it("rescans when a hidden field becomes a password field", () => {
        document.body.innerHTML = "<input id=\"p\" type=\"hidden\">";

        const records = recordsOf(() => {
            (document.getElementById("p") as HTMLInputElement).type = "password";
        });

        expect(check(records)).toBe(true);
    });

    it("stops searching at the first change worth a rescan", () => {
        const wrappers = Array.from({ length: 50 }, (_, i) => bigWrapper(`w${i}`, 10));
        wrappers[0].insertAdjacentHTML("beforeend", "<input type=\"text\">");
        const search = vi.spyOn(formUtils, "deepContains");

        const records = recordsOf(() => {
            for (const w of wrappers) w.classList.add("active");
        });

        expect(records).toHaveLength(50);
        expect(check(records)).toBe(true);
        expect(search).toHaveBeenCalledTimes(1);
    });
});

describe("RescanBackoff", () => {
    it("doubles the wait every 8 rescans up to 5 seconds", () => {
        const backoff = new RescanBackoff();
        const delays = Array.from({ length: 40 }, () => backoff.next());

        expect(delays.slice(0, 7)).toEqual(Array(7).fill(500));
        expect(delays.slice(7, 15)).toEqual(Array(8).fill(1000));
        expect(delays.slice(15, 23)).toEqual(Array(8).fill(2000));
        expect(delays.slice(23, 31)).toEqual(Array(8).fill(4000));
        expect(delays.slice(31)).toEqual(Array(9).fill(5000));
    });

    it("gives up after too many rescans, and starts over on a new page", () => {
        const backoff = new RescanBackoff();
        for (let i = 0; i < RescanBackoff.HARD_LIMIT; i++) expect(backoff.next()).not.toBeNull();

        expect(backoff.next()).toBeNull();

        backoff.reset();
        expect(backoff.next()).toBe(RescanBackoff.MIN_MS);
    });
});
