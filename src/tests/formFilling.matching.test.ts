// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { createHarness, makeEntry } from "./helpers/formFillingHarness";

beforeEach(() => {
    document.body.innerHTML = "";
});

describe("form detection", () => {
    it("treats a user + password form as a login form and fills both fields", () => {
        const h = createHarness(`
            <form id="loginForm">
                <input id="user" name="username" type="text">
                <input id="pass" name="password" type="password">
                <button type="submit">Sign in</button>
            </form>`);

        h.run([
            makeEntry([
                { type: "text", value: "alice", id: "user", name: "username" },
                { type: "password", value: "s3cret", id: "pass", name: "password" }
            ])
        ]);

        expect(h.fieldValue("user")).toBe("alice");
        expect(h.fieldValue("pass")).toBe("s3cret");
    });

    it("ignores a form with no password field and nothing whitelisted", () => {
        const h = createHarness(`
            <form id="searchForm">
                <input id="q" name="q" type="text">
                <button type="submit">Search</button>
            </form>`);

        h.scan();
        // No login form => no search sent to KeePassRPC.
        expect(h.matchFinder).not.toHaveBeenCalled();
    });

    it("sends exactly one KeePassRPC search even with multiple forms", () => {
        const h = createHarness(`
            <form id="f1"><input type="text" name="u1"><input type="password" name="p1"></form>
            <form id="f2"><input type="text" name="u2"><input type="password" name="p2"></form>`);
        h.scan();
        expect(h.matchFinder).toHaveBeenCalledTimes(1);
    });
});

describe("relevance scoring", () => {
    it("scores the form whose field names match the entry higher", () => {
        const h = createHarness(`
            <form id="wrong">
                <input type="text" name="firstname">
                <input type="password" name="pin">
            </form>
            <form id="right">
                <input type="text" name="username">
                <input type="password" name="password">
            </form>`);

        h.run([
            makeEntry([
                { type: "text", value: "alice", name: "username" },
                { type: "password", value: "s3cret", name: "password" }
            ])
        ]);

        const scores = h.matchResult().formRelevanceScores as number[];
        // index 1 is #right
        expect(scores[1]).toBeGreaterThan(scores[0]);
    });

    it("marks a hidden form with unrecognisable fields as a low field-match ratio", () => {
        // display:none + no id + a name the entry does not share => each field
        // scores below the per-field match threshold, so the ratio is low and
        // the entry would not be auto-filled.
        const h = createHarness(`
            <form id="loginForm">
                <input name="aaa" type="text" style="display:none">
                <input name="bbb" type="password" style="display:none">
            </form>`);

        h.run([
            makeEntry([
                { type: "text", value: "alice", name: "username" },
                { type: "password", value: "s3cret", name: "password" }
            ])
        ]);

        const scored = h.matchResult().entries[0][0];
        expect(scored.lowFieldMatchRatio).toBe(true);
    });

    it("still fills even mismatched field names when no field-name punishment applies", () => {
        // Default KPRPC session has no KPRPC_FIELD_DEFAULT_NAME_AND_ID_EMPTY feature,
        // so a visible field of the right type is a match regardless of its name.
        const h = createHarness(`
            <form id="loginForm">
                <input id="u" name="totally-different" type="text">
                <input id="p" name="also-different" type="password">
            </form>`);

        h.run([
            makeEntry([
                { type: "text", value: "alice", name: "username" },
                { type: "password", value: "s3cret", name: "password" }
            ])
        ]);

        expect(h.fieldValue("u")).toBe("alice");
        expect(h.fieldValue("p")).toBe("s3cret");
        expect(h.matchResult().entries[0][0].lowFieldMatchRatio).toBe(false);
    });
});

describe("shadow DOM logins", () => {
    it("detects and fills a login rendered inside an open shadow root", () => {
        const h = createHarness("<login-widget></login-widget>");
        const host = document.querySelector("login-widget")!;
        const sr = host.attachShadow({ mode: "open" });
        sr.innerHTML = `
            <form>
                <input id="su" name="username" type="text">
                <input id="sp" name="password" type="password">
                <button type="submit">Log in</button>
            </form>`;

        h.run([
            makeEntry([
                { type: "text", value: "bob", name: "username" },
                { type: "password", value: "hunter2", name: "password" }
            ])
        ]);

        expect((sr.getElementById("su") as HTMLInputElement).value).toBe("bob");
        expect((sr.getElementById("sp") as HTMLInputElement).value).toBe("hunter2");
    });

    it("ignores non-credential shadow inputs so dashboards don't blow the field limit", () => {
        const h = createHarness("<dash-board></dash-board>");
        const sr = document
            .querySelector("dash-board")!
            .attachShadow({ mode: "open" });
        let sliders = "";
        for (let i = 0; i < 80; i++) sliders += `<input type="range" name="s${i}">`;
        sr.innerHTML = `
            ${sliders}
            <input id="du" name="username" type="text">
            <input id="dp" name="password" type="password">`;

        h.scan();
        // If the 80 range inputs had been collected, getFormFields would throw
        // "Too many fields" and no search would be sent.
        expect(h.matchFinder).toHaveBeenCalledTimes(1);

        h.deliverEntries([
            makeEntry([
                { type: "text", value: "bob", name: "username" },
                { type: "password", value: "hunter2", name: "password" }
            ])
        ]);
        expect((sr.getElementById("dp") as HTMLInputElement).value).toBe("hunter2");
    });

    it("detects shadow-DOM inputs that are not wrapped in a <form>", () => {
        const h = createHarness("<login-widget></login-widget>");
        const sr = document
            .querySelector("login-widget")!
            .attachShadow({ mode: "open" });
        sr.innerHTML = `
            <input id="lu" name="username" type="text">
            <input id="lp" name="password" type="password">`;

        h.scan();
        expect(h.matchFinder).toHaveBeenCalledTimes(1);

        h.deliverEntries([
            makeEntry([
                { type: "text", value: "bob", name: "username" },
                { type: "password", value: "hunter2", name: "password" }
            ])
        ]);
        expect((sr.getElementById("lp") as HTMLInputElement).value).toBe("hunter2");
    });
});

describe("fill diagnosis", () => {
    const report = (h: ReturnType<typeof createHarness>): string[] => {
        const call = h.port.postMessage.mock.calls
            .map(c => c[0])
            .find((m: { diagnoseFillReport?: string[] }) => m && m.diagnoseFillReport);
        return call ? call.diagnoseFillReport : [];
    };

    it("warns when the entry's URLs do not cover the current origin", () => {
        const h = createHarness(`
            <form><input name="username" type="text"><input name="password" type="password"></form>`);
        h.formFilling.diagnoseFillForEntry(
            makeEntry(
                [
                    { type: "text", value: "a", name: "username" },
                    { type: "password", value: "b", name: "password" }
                ],
                { URLs: ["https://some-other-site.example/"] }
            )
        );
        expect(report(h).some(l => l.startsWith("WARNING: none of this entry's URLs"))).toBe(
            true
        );
    });

    it("does not warn when an entry URL matches the current origin", () => {
        const h = createHarness(`
            <form><input name="username" type="text"><input name="password" type="password"></form>`);
        h.formFilling.diagnoseFillForEntry(
            makeEntry(
                [
                    { type: "text", value: "a", name: "username" },
                    { type: "password", value: "b", name: "password" }
                ],
                { URLs: [window.location.origin + "/login"] }
            )
        );
        expect(report(h).some(l => l.startsWith("WARNING: none of this entry's URLs"))).toBe(
            false
        );
    });
});

describe("field filling", () => {
    it("does not overwrite a field that already has a value during automated fill", () => {
        const h = createHarness(`
            <form>
                <input id="user" name="username" type="text" value="prefilled">
                <input id="pass" name="password" type="password">
            </form>`);

        h.run([
            makeEntry([
                { type: "text", value: "alice", name: "username" },
                { type: "password", value: "s3cret", name: "password" }
            ])
        ]);

        expect(h.fieldValue("user")).toBe("prefilled");
        expect(h.fieldValue("pass")).toBe("s3cret");
    });
});
