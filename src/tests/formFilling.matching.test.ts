// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHarness, makeEntry, resetHarness } from "./helpers/formFillingHarness";

beforeEach(() => {
    document.body.innerHTML = "";
});
afterEach(resetHarness);

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

    // Step 2 of the auth.gmx.net login: a light-DOM <form> with a readonly email
    // field and a <lux-password> web component whose real <input> (no id/name)
    // is in its shadow root. That input has no .form, so it used to land in the
    // orphaned-fields pseudo-form while the username-only real form won, leaving
    // the password unfilled and without an icon.
    it("treats shadow inputs of a web component inside a <form> as part of that form", () => {
        const h = createHarness(`
            <form novalidate id="container-password">
                <span class="lux-floating-label">
                    <label for="username">E-Mail</label>
                    <input id="input-username" class="lux-form-element" autocomplete="username"
                        readonly type="email" value="bob@example.com">
                </span>
                <span class="lux-floating-label">
                    <label for="input-password">Passwort</label>
                    <lux-password id="input-password" name="password" autocomplete="current-password"
                        class="lux-form-element"></lux-password>
                </span>
                <button type="submit" id="button-next">Login</button>
                <button id="button-back">Zurück</button>
            </form>`);
        const sr = document.querySelector("lux-password")!.attachShadow({ mode: "open" });
        sr.innerHTML = `<input class="input" part="input" type="password">
            <label for="toggle">Show password</label>
            <input class="toggle" part="toggle" id="toggle" type="checkbox">`;
        const password = sr.querySelector<HTMLInputElement>("input.input")!;

        h.run([
            makeEntry([
                { type: "text", value: "bob@example.com", name: "username" },
                { type: "password", value: "hunter2", name: "password" }
            ])
        ]);

        // One form holding both fields, no pseudo-form
        expect(h.matchResult().forms).toHaveLength(1);
        expect(h.matchResult().passwordFieldsArray[0].map(f => f.DOMelement)).toEqual([password]);
        expect(password.value).toBe("hunter2");
        const [pwFields, otherFields] = h.keeFieldIcon.addKeeIconToFields.mock.calls[0];
        expect(pwFields.map(f => f.DOMelement)).toEqual([password]);
        expect(otherFields.map(f => f.DOMelement.id)).toContain("input-username");
    });

    it("keeps shadow inputs in document order among the form's light fields", () => {
        const h = createHarness(`
            <form>
                <x-user></x-user>
                <input id="pass" name="password" type="password">
            </form>`);
        document.querySelector("x-user")!.attachShadow({ mode: "open" }).innerHTML =
            "<input id=\"user\" name=\"username\" type=\"text\">";

        const fields = h.formUtils.getFormElements(document.querySelector("form"));

        expect(fields.map(f => f.id)).toEqual(["user", "pass"]);
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
        expect(report(h).some(l => l.startsWith("[warn] None of this entry's URLs"))).toBe(
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
        expect(report(h).some(l => l.startsWith("[warn] None of this entry's URLs"))).toBe(
            false
        );
    });

    it("runs a full diagnosis without the internal error guard tripping", () => {
        const h = createHarness(`
            <form id="loginForm">
                <input id="u" name="username" type="text">
                <input id="p" name="password" type="password">
                <button type="submit">Sign in</button>
            </form>`);
        h.formFilling.diagnoseFillForEntry(
            makeEntry([
                { type: "text", value: "alice", name: "username", id: "u" },
                { type: "password", value: "s3cret", name: "password", id: "p" }
            ])
        );
        const lines = report(h);
        expect(lines.some(l => l.includes("Diagnosis stopped with an error"))).toBe(false);
        // force-fill path reached and the fields were populated
        expect(lines.some(l => l.startsWith("[ok] Filled "))).toBe(true);
        expect(h.fieldValue("u")).toBe("alice");
        expect(h.fieldValue("p")).toBe("s3cret");
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

describe("two-step logins", () => {
    // auth.gmx.net: step 1 asks for the email only, step 2 (same page, re-rendered)
    // shows the email readonly plus a <lux-password> web component
    const STEP1 = `
        <form id="container-username">
            <input id="input-username" autocomplete="username" type="email">
            <button type="submit">Weiter</button>
        </form>`;
    const STEP2 = `
        <form id="container-password">
            <input id="input-username" autocomplete="username" readonly type="email" value="b@example.com">
            <lux-password id="input-password" name="password"></lux-password>
            <button type="submit">Login</button>
        </form>`;

    const entries = () =>
        ["a", "b", "c", "d"].map(u =>
            makeEntry(
                [
                    { type: "text", value: `${u}@example.com`, name: "username" },
                    { type: "password", value: `pw-${u}`, name: "password" }
                ],
                { uuid: `uuid-${u}`, title: `GMX ${u}` }
            )
        );

    function showStep2() {
        document.body.innerHTML = STEP2;
        document.querySelector("lux-password")!.attachShadow({ mode: "open" }).innerHTML =
            "<input class=\"input\" part=\"input\" type=\"password\">";
        return document.querySelector("lux-password")!.shadowRoot!.querySelector("input")!;
    }

    function pickOnStep1(h: ReturnType<typeof createHarness>, uuid: string) {
        h.run(entries());
        const index = h.matchResult().entries[0].findIndex(e => e.uuid === uuid);
        h.manualFill(index);
        expect(h.fieldValue("input-username")).toBe("b@example.com");
    }

    afterEach(() => vi.useRealTimers());

    it("fills the entry picked on step 1 on step 2, even with several matches", () => {
        const h = createHarness(STEP1);
        pickOnStep1(h, "uuid-b");

        const password = showStep2();
        h.run(entries());

        expect(password.value).toBe("pw-b");
    });

    it("doesn't pick an entry by itself on step 2 when several match", () => {
        const h = createHarness(STEP1);
        h.run(entries());

        const password = showStep2();
        h.run(entries());

        expect(password.value).toBe("");
    });

    it("uses the pick only once, so a failed login isn't refilled in a loop", () => {
        const h = createHarness(STEP1);
        pickOnStep1(h, "uuid-b");
        showStep2();
        h.run(entries());

        const password = showStep2(); // e.g. GMX shows the step again after a wrong password
        h.run(entries());

        expect(password.value).toBe("");
    });

    it("forgets the pick after a minute", () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        const h = createHarness(STEP1);
        pickOnStep1(h, "uuid-b");

        vi.setSystemTime(Date.now() + 61 * 1000);
        const password = showStep2();
        h.run(entries());

        expect(password.value).toBe("");
    });

    // Sites whose next step is a new page: the background keeps the pick for the
    // tab (background/ManualPicks) and hands it to the next page when it connects

    const posted = (h: ReturnType<typeof createHarness>) => h.port.postMessage.mock.calls.map(c => c[0]);

    it("tells the background about a pick made by hand", () => {
        const h = createHarness(STEP1);
        pickOnStep1(h, "uuid-b");

        expect(posted(h)).toContainEqual({ manualPick: { uuid: "uuid-b" } });
    });

    it("fills the pick the background handed over on a newly loaded step 2", () => {
        createHarness(STEP1);
        const h = createHarness(STEP2); // a new page: a new copy of the page script
        const password = showStep2();

        h.formFilling.restoreManualPick({ uuid: "uuid-b", at: Date.now() - 5000 });
        h.run(entries());

        expect(password.value).toBe("pw-b");
        expect(posted(h)).toContainEqual({ manualPickUsed: true });
    });

    it("doesn't use a handed-over pick that is over a minute old", () => {
        const h = createHarness(STEP2);
        const password = showStep2();

        h.formFilling.restoreManualPick({ uuid: "uuid-b", at: Date.now() - 61 * 1000 });
        h.run(entries());

        expect(password.value).toBe("");
        expect(posted(h)).not.toContainEqual({ manualPickUsed: true });
    });
});

describe("rescans after DOM changes", () => {
    const LOGIN = `
        <form id="login">
            <input id="user" name="username" type="text">
            <input id="pass" name="password" type="password">
        </form>`;
    const entry = () =>
        makeEntry([
            { type: "text", value: "alice", name: "username" },
            { type: "password", value: "pw", name: "password" }
        ]);
    const rescan = (h: ReturnType<typeof createHarness>) => h.formFilling.findMatchesInThisFrame({}, true);

    it("does nothing when the login fields are the same as before", () => {
        const h = createHarness(LOGIN);
        h.run([entry()]);
        document.getElementById("login")!.className = "has-value";

        rescan(h);

        expect(h.matchFinder).toHaveBeenCalledTimes(1);
        expect(h.keeFieldIcon.removeKeeIconFromAllFields).not.toHaveBeenCalled();
        expect(h.matchResult().passwordFieldsArray[0]).toHaveLength(1);
    });

    it("scans again when a field is revealed", () => {
        const h = createHarness(LOGIN.replace("type=\"password\"", "type=\"password\" hidden"));
        h.run([entry()]);

        document.getElementById("pass")!.removeAttribute("hidden");
        rescan(h);

        expect(h.matchFinder).toHaveBeenCalledTimes(2);
    });

    it("scans again when the form is replaced, even by an identical one", () => {
        const h = createHarness(LOGIN);
        h.run([entry()]);

        document.body.innerHTML = LOGIN;
        rescan(h);

        expect(h.matchFinder).toHaveBeenCalledTimes(2);
    });

    it("scans again when a password field turns into a text field", () => {
        const h = createHarness(LOGIN);
        h.run([entry()]);

        (document.getElementById("pass") as HTMLInputElement).type = "text";
        rescan(h);

        expect(h.matchFinder).toHaveBeenCalledTimes(2);
    });

    it("sees a web component that attached its shadow root since the last scan", () => {
        // Like <lux-password> on auth.gmx.net, hydrated after the first scan:
        // attaching a shadow root is no DOM change the observer would report
        const h = createHarness(`
            <form id="login">
                <input id="user" name="username" type="text">
                <lux-password id="pw" name="password"></lux-password>
            </form>`);
        h.run([entry()]);
        expect(h.matchResult().passwordFieldsArray[0]).toHaveLength(0);

        document.getElementById("pw")!.attachShadow({ mode: "open" }).innerHTML =
            "<input type=\"password\">";
        rescan(h);

        expect(h.matchResult().passwordFieldsArray[0]).toHaveLength(1);
    });

    it("always scans when asked to directly", () => {
        const h = createHarness(LOGIN);
        h.run([entry()]);

        h.scan();

        expect(h.matchFinder).toHaveBeenCalledTimes(2);
    });
});
