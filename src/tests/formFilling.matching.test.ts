// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHarness, makeEntry, resetHarness } from "./helpers/formFillingHarness";
import { FormUtils } from "../page/formsUtils";

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

    describe("forms without a password field", () => {
        // Synology DSM's edit user dialog
        const PROFILE = `
            <form id="profile">
                <input id="name" name="name" type="text">
                <input id="description" name="description" type="text">
                <input id="email" name="email" type="text">
            </form>`;

        it("ignores a form with just a field called name", () => {
            const h = createHarness("<form><input id=\"name\" name=\"name\" type=\"text\"></form>");
            h.scan();
            expect(h.matchFinder).not.toHaveBeenCalled();
        });

        it("ignores a profile form with too many text fields for a first step", () => {
            const h = createHarness(PROFILE);
            h.scan();
            expect(h.matchFinder).not.toHaveBeenCalled();
        });

        describe("but a hidden one", () => {
            // Synology DSM's create user dialog: the password fields wait on a later page
            const CREATE_USER = `
                <form id="create">
                    <input id="name" name="name" type="text">
                    <input id="description" name="description" type="text">
                    <input id="email" name="email" type="text">
                    <input id="pw" name="password" type="password" style="display:none" disabled>
                    <input id="pw2" name="confirmpassword" type="password" style="display:none" disabled>
                </form>`;

            it("ignores a form asking too much for a first step", () => {
                const h = createHarness(CREATE_USER);
                h.scan();
                expect(h.matchFinder).not.toHaveBeenCalled();
            });

            it("still takes a username field with a hidden password field for a first step", () => {
                const h = createHarness(`
                    <form id="login">
                        <input id="user" name="user" type="text">
                        <input id="pw" name="password" type="password" style="display:none">
                    </form>`);
                h.scan();
                expect(h.matchFinder).toHaveBeenCalledTimes(1);
            });

            it("is a login form again once the password field shows", () => {
                const h = createHarness(CREATE_USER);
                h.scan();

                document.getElementById("pw")!.style.display = "";
                h.formFilling.findMatchesInThisFrame({}, true);

                expect(h.matchFinder).toHaveBeenCalledTimes(1);
            });

            it("drops a dialog that was hidden during the scan once it shows", () => {
                // The harness only looks at a field's own style
                const h = createHarness(CREATE_USER.replaceAll("type=\"text\"", "type=\"text\" style=\"display:none\""));
                h.run([
                    makeEntry([
                        { type: "text", value: "alice", name: "" },
                        { type: "password", value: "pw", name: "" }
                    ])
                ]);
                expect(h.matchFinder).toHaveBeenCalledTimes(1);

                document.querySelectorAll<HTMLElement>("input[type=text]").forEach(f => (f.style.display = ""));
                h.formFilling.findMatchesInThisFrame({}, true);

                expect(h.matchResult().passwordFieldsArray[0]).toBeUndefined();
                expect(h.keeFieldIcon.removeKeeIconFromAllFields).toHaveBeenCalled();

                // The answer to a search sent before the dialog showed
                h.formFilling.findLoginsResultHandler([
                    makeEntry([
                        { type: "text", value: "alice", name: "" },
                        { type: "password", value: "pw", name: "" }
                    ])
                ]);
                expect(h.fieldValue("email")).toBe("");
            });
        });

        it("doesn't limit the loose fields of a page without a form", () => {
            const h = createHarness(`
                <input name="email" type="text">
                <input name="newsletter" type="text">
                <input name="store" type="text">`);
            h.scan();
            expect(h.matchFinder).toHaveBeenCalledTimes(1);
        });

        describe("with only a generic field name to go on", () => {
            const UNNAMED = () =>
                makeEntry([
                    { type: "text", value: "alice", name: "" },
                    { type: "password", value: "s3cret", name: "" }
                ]);
            const fit = (h: ReturnType<typeof createHarness>) =>
                h.matchResult().entries[0][0].formFit;

            it.each(["email", "e-mail", "mail", "id"])(
                "offers but doesn't fill a lone field called %s by itself",
                name => {
                    const h = createHarness(`<form><input id="f" name="${name}" type="text"></form>`);
                    h.run([UNNAMED()]);
                    expect(fit(h).blocker).toEqual({ code: "unsure-first-step" });
                    expect(h.fieldValue("f")).toBe("");
                }
            );

            it("still fills it when the user picks the entry", () => {
                const h = createHarness("<form><input id=\"f\" name=\"email\" type=\"text\"></form>");
                h.run([UNNAMED()]);
                h.manualFill(0);
                expect(h.fieldValue("f")).toBe("alice");
            });

            it("fills it by itself when the entry stores the field's name", () => {
                const h = createHarness("<form><input id=\"f\" name=\"email\" type=\"text\"></form>");
                h.run([
                    makeEntry([
                        { type: "text", value: "alice", name: "email" },
                        { type: "password", value: "s3cret", name: "" }
                    ])
                ]);
                expect(fit(h).blocker).toBeNull();
                expect(h.fieldValue("f")).toBe("alice");
            });

            it("fills it by itself when the site marks it as a username", () => {
                const h = createHarness(
                    "<form><input id=\"f\" name=\"email\" type=\"text\" autocomplete=\"username\"></form>"
                );
                h.run([UNNAMED()]);
                expect(h.fieldValue("f")).toBe("alice");
            });

            it("fills it by itself when this site's own Include List names the form", () => {
                const h = createHarness("<form id=\"mine\"><input id=\"f\" name=\"email\" type=\"text\"></form>");
                const host = new URL(document.URL).host;
                h.cfg().siteConfig.hostExact = {
                    [host]: {
                        config: { whiteList: { form: { ids: ["mine"] } } },
                        matchWeight: 100,
                        source: "User"
                    }
                };
                h.run([UNNAMED()]);
                delete h.cfg().siteConfig.hostExact[host];
                expect(h.fieldValue("f")).toBe("alice");
            });

            it("fills a field with a clear username name by itself", () => {
                const h = createHarness("<form><input id=\"f\" name=\"username\" type=\"text\"></form>");
                h.run([UNNAMED()]);
                expect(h.fieldValue("f")).toBe("alice");
            });

            it("doesn't apply when the form has a password field, even a hidden one", () => {
                const h = createHarness(`
                    <form>
                        <input id="f" name="email" type="text">
                        <input id="p" name="password" type="password" style="display:none">
                    </form>`);
                h.run([UNNAMED()]);
                expect(h.fieldValue("f")).toBe("alice");
            });
        });

        it("takes a username field and one more for a first step", () => {
            const h = createHarness(`
                <form>
                    <input name="email" type="text">
                    <input name="captcha" type="text">
                </form>`);
            h.scan();
            expect(h.matchFinder).toHaveBeenCalledTimes(1);
        });

        it("doesn't count hidden or read-only fields against a first step", () => {
            const h = createHarness(`
                <form>
                    <input name="email" type="text">
                    <input name="trap" type="text" style="display:none">
                    <input name="tenant" type="text" readonly>
                    <input name="captcha" type="text">
                </form>`);
            h.scan();
            expect(h.matchFinder).toHaveBeenCalledTimes(1);
        });

        it("believes a field marked autocomplete=username, however many others there are", () => {
            const h = createHarness(`
                <form>
                    <input name="account" type="text" autocomplete="username">
                    <input name="a" type="text">
                    <input name="b" type="text">
                </form>`);
            h.scan();
            expect(h.matchFinder).toHaveBeenCalledTimes(1);
        });

        it("believes this site's own Include List", () => {
            const h = createHarness(PROFILE);
            h.cfg().siteConfig.hostExact = {
                [new URL(document.URL).host]: {
                    config: { whiteList: { form: { ids: ["profile"] } } },
                    matchWeight: 100,
                    source: "User"
                }
            };
            h.scan();
            expect(h.matchFinder).toHaveBeenCalledTimes(1);
            delete h.cfg().siteConfig.hostExact[new URL(document.URL).host];
        });
    });
});

describe("how an entry fits a form", () => {
    const UNNAMED = () =>
        makeEntry([
            { type: "text", value: "alice", name: "" },
            { type: "password", value: "s3cret", name: "" }
        ]);
    const fit = (h: ReturnType<typeof createHarness>, form = 0) => h.matchResult().entries[form][0].formFit;

    it("fills the form whose field names the entry stores, not the first one", () => {
        const h = createHarness(`
            <form id="wrong">
                <input type="text" id="first" name="firstname">
                <input type="password" id="pin" name="pin">
            </form>
            <form id="right">
                <input type="text" id="user" name="username">
                <input type="password" id="pass" name="password">
            </form>`);

        h.run([
            makeEntry([
                { type: "text", value: "alice", name: "username" },
                { type: "password", value: "s3cret", name: "password" }
            ])
        ]);

        expect(h.matchResult().formFits.map(f => f.storedMatches)).toEqual([0, 2]);
        expect(h.fieldValue("user")).toBe("alice");
        expect(h.fieldValue("first")).toBe("");
    });

    it("prefers a form with a password field to a username-only first step", () => {
        const h = createHarness(`
            <form id="step"><input type="text" id="u1" name="username" autocomplete="username"></form>
            <form id="login">
                <input type="text" id="u2" name="login">
                <input type="password" id="pass" name="password">
            </form>`);

        h.run([UNNAMED()]);

        expect(h.matchResult().formFits.map(f => f.loginField)).toEqual(["username", "password"]);
        expect(h.fieldValue("u2")).toBe("alice");
        expect(h.fieldValue("u1")).toBe("");
    });

    it("doesn't fill a hidden form by itself: it has no login field", () => {
        const h = createHarness(`
            <form id="loginForm">
                <input name="aaa" type="text" style="display:none">
                <input name="bbb" type="password" style="display:none">
            </form>`);

        h.run([UNNAMED()]);

        expect(fit(h).blocker).toEqual({ code: "no-login-field" });
        expect(h.fieldValue("bbb")).toBe("");
    });

    it("fills fields whose names differ from the entry's stored ones", () => {
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

        expect(fit(h).blocker).toBeNull();
        expect(h.fieldValue("u")).toBe("alice");
        expect(h.fieldValue("p")).toBe("s3cret");
    });

    it.each([
        ["a new-password field", '<input type="password" id="pass" name="pw" autocomplete="new-password">'],
        ["two password fields", '<input type="password" id="pass" name="pw"><input type="password" id="pass2" name="pw2">']
    ])("doesn't fill a sign-up form with %s by itself", (_, passwords) => {
        const h = createHarness(`<form><input type="text" id="user" name="username">${passwords}</form>`);

        h.run([UNNAMED()]);

        expect(fit(h).blocker).toEqual({ code: "sign-up-form" });
        expect(h.fieldValue("user")).toBe("");
    });

    it("names the fields the entry has nothing for when there are too many", () => {
        const h = createHarness(`
            <form>
                <input type="text" id="first" name="first" aria-label="First name">
                <input type="text" id="user" name="username">
                <input type="text" id="street" name="street">
                <input type="password" id="pass" name="password">
            </form>`);

        h.run([UNNAMED()]);

        expect(fit(h).blocker).toEqual({ code: "extra-fields", fields: ["first name", "street"] });
    });

    it("fills a login with one more field, such as a captcha", () => {
        const h = createHarness(`
            <form>
                <input type="text" id="user" name="username">
                <input type="password" id="pass" name="password">
                <input type="text" id="captcha" name="captcha">
            </form>`);

        h.run([UNNAMED()]);

        expect(fit(h).blocker).toBeNull();
        expect(h.fieldValue("user")).toBe("alice");
        expect(h.fieldValue("captcha")).toBe("");
    });

    // Sparkasse: the password field stays hidden until the username is in,
    // next to a hidden, disabled field that is there to catch bots
    it("fills the first step of a login whose password field is still hidden", () => {
        const h = createHarness(`
            <form id="a53530be45192ad3">
                <input type="text" id="trap" name="lyUq" style="display:none" disabled>
                <input type="text" id="user" name="kATT" aria-label="Anmeldename" autocomplete="username">
                <input type="password" id="pass" name="rjjU" autocomplete="off" style="display:none">
            </form>`);

        h.run([UNNAMED()]);

        expect(fit(h)).toEqual({ loginField: "username", storedMatches: 0, blocker: null });
        expect(h.fieldValue("user")).toBe("alice");
        expect(h.fieldValue("trap")).toBe("");
    });

    it("offers entries by how exactly their URL matches, then by stored field names", () => {
        const h = createHarness(`
            <form><input type="text" id="user" name="username"><input type="password" id="pass" name="password"></form>`);
        const named = (uuid: string, matchAccuracy: number, name: string) =>
            Object.assign(
                makeEntry([
                    { type: "text", value: uuid, name },
                    { type: "password", value: "x", name: "" }
                ]),
                { uuid, matchAccuracy }
            );

        h.run([named("domain", 10, "username"), named("host", 30, ""), named("host-named", 30, "username")]);

        expect(h.postedEntries()[0].map(e => e.uuid)).toEqual(["host-named", "host", "domain"]);
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

    const UNNAMED_FOR_REPORT = () =>
        makeEntry([
            { type: "text", value: "alice", name: "" },
            { type: "password", value: "s3cret", name: "" }
        ]);

    it("says a form with a password field is a login because of that", () => {
        const h = createHarness(`
            <form id="f"><input name="u" type="text"><input name="p" type="password"></form>`);
        h.formFilling.diagnoseFillForEntry(UNNAMED_FOR_REPORT());
        expect(report(h)).toContain("[ok] Form #0 (f): treated as a login form: it has a password field.");
    });

    it("names the Include List entry that made a form a login", () => {
        const h = createHarness("<form id=\"f\"><input id=\"e\" name=\"email\" type=\"text\"></form>");
        h.formFilling.diagnoseFillForEntry(UNNAMED_FOR_REPORT());
        expect(report(h)).toContain(
            "[ok] Form #0 (f): treated as a login form: the Include List for all websites names its field name \"email\"."
        );
    });

    it("says when autocomplete=username made a form a login", () => {
        const h = createHarness("<form id=\"f\"><input name=\"acct\" type=\"text\" autocomplete=\"username\"></form>");
        h.formFilling.diagnoseFillForEntry(UNNAMED_FOR_REPORT());
        expect(report(h)).toContain(
            "[ok] Form #0 (f): treated as a login form: a field has autocomplete=\"username\"."
        );
    });

    it("explains a form turned down for asking too much of a first step", () => {
        const h = createHarness(`
            <form id="profile">
                <input name="name" type="text"><input name="description" type="text"><input name="email" type="text">
            </form>
            <form id="login"><input name="u" type="text"><input name="p" type="password"></form>`);
        h.formFilling.diagnoseFillForEntry(UNNAMED_FOR_REPORT());
        expect(report(h).some(l => l.includes("too many for the first step of a login"))).toBe(true);
    });

    it("explains a form with a hidden password field turned down for asking too much", () => {
        const h = createHarness(`
            <form id="create">
                <input name="name" type="text"><input name="description" type="text"><input name="email" type="text">
                <input name="password" type="password" style="display:none" disabled>
            </form>
            <form id="login"><input name="u" type="text"><input name="p" type="password"></form>`);
        h.formFilling.diagnoseFillForEntry(UNNAMED_FOR_REPORT());
        const lines = report(h);
        expect(lines).toContain("[warn] Form #0 (create): NOT treated as a login form.");
        expect(
            lines.some(
                l => l.includes("Its password field is hidden") && l.includes("too many for the first step of a login")
            )
        ).toBe(true);
    });

    it("doesn't type into a form without a password field", () => {
        const h = createHarness("<form id=\"f\"><input id=\"e\" name=\"email\" type=\"text\"></form>");
        h.formFilling.diagnoseFillForEntry(UNNAMED_FOR_REPORT());
        const lines = report(h);
        expect(h.fieldValue("e")).toBe("");
        expect(lines.some(l => l.includes("Not filled: the best form has no visible password field"))).toBe(true);
        expect(lines.some(l => l.includes("No fields were filled"))).toBe(false);
    });

    it("doesn't type into a form whose password field is hidden", () => {
        const h = createHarness(`
            <form id="f">
                <input id="u" name="u" type="text">
                <input id="p" name="p" type="password" style="display:none">
            </form>`);
        h.formFilling.diagnoseFillForEntry(UNNAMED_FOR_REPORT());
        expect(h.fieldValue("u")).toBe("");
        expect(h.fieldValue("p")).toBe("");
        expect(report(h).some(l => l.includes("Not filled: the best form has no visible password field"))).toBe(true);
    });

    // Like the Proxmox VE login (ExtJS): no <form>, generated ids, read-only
    // dropdown inputs, and the app's own search box elsewhere on the page
    const LOOSE_LOGIN = `
        <div class="header"><input type="text" id="textfield-1010-inputEl" name="filter" placeholder="Search"></div>
        <div class="login-window">
            <label for="textfield-1031-inputEl">User name:</label>
            <input type="text" id="textfield-1031-inputEl" name="username" aria-label="User name">
            <label for="textfield-1032-inputEl">Password:</label>
            <input type="password" id="textfield-1032-inputEl" name="password">
            <input type="text" id="combo-1033-inputEl" name="realm" readonly value="pam">
            <input type="checkbox" id="checkbox-1035-inputEl">
        </div>`;
    // As KeePass stores most entries: no field name or id to match against
    const UNNAMED_ENTRY = () =>
        makeEntry([
            { type: "text", value: "user-value-7f3a", name: "" },
            { type: "password", value: "pass-value-9c1e", name: "" }
        ]);

    it("lists every field of the filled form, what was filled and why", () => {
        const h = createHarness(LOOSE_LOGIN);
        h.formFilling.diagnoseFillForEntry(UNNAMED_ENTRY());
        const lines = report(h);

        const start = lines.findIndex(l => l.startsWith("## Fields of form #"));
        expect(start).toBeGreaterThan(-1);
        const fields = lines.slice(start + 1).filter(l => l.startsWith("- #"));
        const field = (name: string) => fields.find(l => l.includes(`name="${name}"`));

        // (jsdom has no innerText, so <label> texts are missing here; aria-label works)
        expect(field("username")).toContain('label="user name"');
        expect(field("username")).toContain("guessed username field");
        expect(field("realm")).toContain("read-only");
        expect(field("filter")).toContain("looks like a search box");
        expect(field("password")).toContain("FILLED");
        // Exactly one text field got the username, and the report says which
        const filledText = fields.filter(l => l.startsWith("- #") && l.includes("FILLED") && !l.includes("password"));
        expect(filledText).toHaveLength(1);
        expect(filledText[0]).toContain('name="username"');

        // Why: the username went to #1 over the search box #0 by the reach rule
        const why = lines.slice(lines.findIndex(l => l.startsWith("## How the fields were chosen")) + 1);
        expect(why[0]).toMatch(/^- "text" → #1: beat #0 at rule 6: can be reached/);
        expect(why.find(l => l.startsWith('- "password"'))).toContain("the only page field left that fits");
        expect(lines.join("\n")).not.toContain("user-value-7f3a");
        expect(lines.join("\n")).not.toContain("pass-value-9c1e");
    });

    it("never puts field values into the report", () => {
        // A form that isn't a login form gets an HTML excerpt in the report
        const h = createHarness(`
            <form id="profile"><input type="text" name="city" value="Springfield"><input type='text' value='42 Main St'></form>
            <form id="loginForm"><input name="username" type="text"><input name="password" type="password"></form>`);
        h.formFilling.diagnoseFillForEntry(
            makeEntry([
                { type: "text", value: "alice", name: "username" },
                { type: "password", value: "s3cret", name: "password" }
            ])
        );
        const text = report(h).join("\n");

        expect(text).toContain('name="city"');
        expect(text).not.toContain("Springfield");
        expect(text).not.toContain("42 Main St");
        expect(text).not.toContain("alice");
        expect(text).not.toContain("s3cret");
    });
});

describe("field filling", () => {
    // Fields that can never take a login value don't count towards how much of
    // the form the entry covers
    it("fills an app's login on load although a search box and read-only fields surround it", () => {
        const h = createHarness(`
            <div class="header"><input type="text" id="search" name="globalSearch" placeholder="Search"></div>
            <div class="login-window">
                <input type="text" id="user" name="username">
                <input type="password" id="pass" name="password">
                <input type="text" id="realm" name="realm" readonly>
                <input type="text" id="lang" name="lang" readonly>
            </div>`);

        h.run([
            makeEntry([
                { type: "text", value: "root", name: "" },
                { type: "password", value: "s3cret", name: "" }
            ])
        ]);

        expect(h.matchResult().entries[h.matchResult().mostRelevantFormIndex][0].formFit.blocker).toBeNull();
        expect(h.fieldValue("user")).toBe("root");
        expect(h.fieldValue("pass")).toBe("s3cret");
        expect(h.fieldValue("search")).toBe("");
    });

    it("still fills on load a login whose fields are read-only until clicked", () => {
        // A trick to keep browsers from filling: readonly, removed on focus
        const h = createHarness(`
            <form>
                <input type="text" id="user" name="username" readonly>
                <input type="password" id="pass" name="password" readonly>
            </form>`);

        h.run([
            makeEntry([
                { type: "text", value: "alice", name: "" },
                { type: "password", value: "s3cret", name: "" }
            ])
        ]);

        expect(h.fieldValue("user")).toBe("alice");
        expect(h.fieldValue("pass")).toBe("s3cret");
    });

    it("still doesn't fill on load a form with many more fields than the entry", () => {
        const h = createHarness(`
            <form>
                <input type="text" id="first" name="first">
                <input type="text" id="last" name="last">
                <input type="text" id="user" name="username">
                <input type="text" id="street" name="street">
                <input type="password" id="pass" name="password">
            </form>`);

        h.run([
            makeEntry([
                { type: "text", value: "root", name: "" },
                { type: "password", value: "s3cret", name: "" }
            ])
        ]);

        expect(h.fieldValue("user")).toBe("");
        expect(h.fieldValue("pass")).toBe("");
    });

    // Proxmox VE: an entry without field names scores all visible text fields the
    // same, and the app's search box comes before the login window
    it("puts the username into the detected username field, not an earlier search box", () => {
        const h = createHarness(`
            <div class="header"><input type="text" id="search-1020" name="globalSearch"></div>
            <div class="login-window">
                <input type="text" id="view-1" name="view" readonly>
                <input type="text" id="user" name="username">
                <input type="password" id="pass" name="password">
                <input type="text" id="realm" name="realm" readonly>
            </div>`);

        h.run([
            makeEntry([
                { type: "text", value: "root", name: "" },
                { type: "password", value: "s3cret", name: "" }
            ])
        ]);
        // Too few fields match for an automatic fill here; this is a click on the entry
        h.manualFill(0);

        expect(h.fieldValue("user")).toBe("root");
        expect(h.fieldValue("search-1020")).toBe("");
        expect(h.fieldValue("realm")).toBe("");
        expect(h.fieldValue("pass")).toBe("s3cret");
    });

    // Nothing is named like a username. The scanner then takes the field just before
    // the password, which in the first layout is the read-only one.
    it.each([
        ["after", `<input type="text" id="account" name="account">
                <input type="text" id="tenant" name="tenant" readonly>`],
        ["before", `<input type="text" id="tenant" name="tenant" readonly>
                <input type="text" id="account" name="account">`]
    ])("prefers an editable field to an equally suitable read-only one %s it", (_, fields) => {
        const h = createHarness(`
            <form>
                ${fields}
                <input type="password" id="pass" name="password">
            </form>`);

        h.run([
            makeEntry([
                { type: "text", value: "alice", name: "" },
                { type: "password", value: "s3cret", name: "" }
            ])
        ]);

        expect(h.fieldValue("account")).toBe("alice");
        expect(h.fieldValue("tenant")).toBe("");
    });

    it("passes over a field something else on the page lies over", () => {
        // Nothing is named like a username; the first field is behind a modal mask
        const h = createHarness(`
            <form>
                <input type="text" id="behind" name="lookup">
                <input type="text" id="account" name="account">
                <input type="password" id="pass" name="password">
            </form>`);
        // (jsdom can't hit-test; the browser tests cover the check itself)
        (h.formFilling as unknown as { fieldFillingDeps: { isCoveredBySite(el: Element): boolean } })
            .fieldFillingDeps.isCoveredBySite = el => el.id === "behind";

        h.run([
            makeEntry([
                { type: "text", value: "alice", name: "" },
                { type: "password", value: "s3cret", name: "" }
            ])
        ]);

        expect(h.fieldValue("account")).toBe("alice");
        expect(h.fieldValue("behind")).toBe("");
    });

    it("still fills the field whose name matches, even before the detected username field", () => {
        const h = createHarness(`
            <form>
                <input type="text" id="mail" name="email">
                <input type="text" id="user" name="username">
                <input type="password" id="pass" name="password">
            </form>`);

        h.run([
            makeEntry([
                { type: "text", value: "alice@example.com", name: "email" },
                { type: "password", value: "s3cret", name: "password" }
            ])
        ]);

        expect(h.fieldValue("mail")).toBe("alice@example.com");
        expect(h.fieldValue("user")).toBe("");
    });

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

// Which field gets the username of an entry that doesn't say (no stored field
// names or ids, as with entries made in KeePass). Each page is one where the
// old guess - first known name, else the field just before the password -
// picked the wrong field.
describe("username field guess", () => {
    const fillUnnamed = (html: string) => {
        const h = createHarness(html);
        h.run([
            makeEntry([
                { type: "text", value: "alice", name: "" },
                { type: "password", value: "s3cret", name: "" }
            ])
        ]);
        // As a click on the entry, in case the page is too loose to fill by itself
        h.manualFill(0);
        expect(h.fieldValue("pass")).toBe("s3cret");
        return Array.from(document.querySelectorAll<HTMLInputElement>("input[type=text]"))
            .filter(i => i.value === "alice")
            .map(i => i.id);
    };

    it.each([
        [
            "autocomplete=username over a known name",
            `<form><input type="text" id="other" name="email">
            <input type="text" id="want" name="acct" autocomplete="username">
            <input type="password" id="pass"></form>`
        ],
        [
            "a label with a colon",
            `<form><input type="text" id="want" name="f1" aria-label="User name:">
            <input type="text" id="other" name="f2">
            <input type="password" id="pass"></form>`
        ],
        [
            "a German label",
            `<form><input type="text" id="want" name="f1" aria-label="Benutzername">
            <input type="text" id="other" name="f2">
            <input type="password" id="pass"></form>`
        ],
        [
            "not a search box, even one with a known name",
            `<form><input type="text" id="other" name="name" placeholder="Search people">
            <input type="text" id="want" name="acct">
            <input type="password" id="pass"></form>`
        ],
        [
            "not a field the site switched off",
            `<form><div inert><input type="text" id="other" name="username"></div>
            <input type="text" id="want" name="login">
            <input type="password" id="pass"></form>`
        ],
        [
            "not a one-time code field just before the password",
            `<form><input type="text" id="want" name="f1">
            <input type="text" id="other" name="f2" autocomplete="one-time-code">
            <input type="password" id="pass"></form>`
        ],
        [
            "on a page without forms, the field by the password over a newsletter e-mail field",
            `<div class="login"><div><input type="text" id="want" name="kennung"></div>
            <div><input type="password" id="pass"></div></div>
            <footer><input type="text" id="other" name="email"></footer>`
        ],
        [
            "in a real form, a known name over the field right by the password",
            `<form><div><input type="text" id="want" name="username"></div>
            <div><input type="text" id="other" name="captcha"><input type="password" id="pass"></div></form>`
        ],
        [
            "the field that shares the password's wrapper",
            `<div class="header"><input type="text" id="other" name="f1"></div>
            <div class="login"><div><input type="password" id="pass"></div>
            <div><input type="text" id="want" name="f2"></div></div>`
        ]
    ])("prefers %s", (_, html) => {
        expect(fillUnnamed(html)).toEqual(["want"]);
    });

    it("on submit, still takes a field the site locked while signing in as the username", () => {
        // Saving reads the fields on submit, when many sites have just disabled them
        document.body.innerHTML = `
            <form id="login">
                <input type="text" id="user" name="username" disabled>
                <input type="text" id="device" name="device-label">
                <input type="password" id="pass" name="password" value="s3cret" disabled>
            </form>`;
        const formUtils = new FormUtils({ debug: () => {}, info: () => {}, warn: () => {} } as never);
        const form = document.getElementById("login");

        const submitted = formUtils.getFormFields(form, true, 50);
        expect(submitted.otherFields[submitted.actualUsernameIndex].DOMelement.id).toBe("user");
    });

    it("leaves a blacklisted search field out of a page without forms instead of skipping the page", () => {
        // name="q" is on the default blacklist, which rightly skips real search forms
        const h = createHarness(`
            <div class="header"><input type="text" id="q" name="q"></div>
            <div class="login">
                <input type="text" id="user" name="username">
                <input type="password" id="pass" name="password">
            </div>`);
        h.run([
            makeEntry([
                { type: "text", value: "alice", name: "username" },
                { type: "password", value: "s3cret", name: "password" }
            ])
        ]);
        h.manualFill(0);

        expect(h.fieldValue("user")).toBe("alice");
        expect(h.fieldValue("pass")).toBe("s3cret");
        expect(h.fieldValue("q")).toBe("");
    });

    it("still skips a real search form", () => {
        const h = createHarness(`
            <form id="search"><input type="text" id="q" name="q"><input type="password" id="pass"></form>`);
        h.scan();

        // Not a login form, so KeePass isn't even asked
        expect(h.matchFinder).not.toHaveBeenCalled();
    });
});
