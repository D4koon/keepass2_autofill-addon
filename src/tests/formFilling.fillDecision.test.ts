// @vitest-environment jsdom
//
// Characterization tests for fillAndSubmit's decision logic. These pin the
// CURRENT behaviour (including known quirks, marked below) so the upcoming
// extraction of a pure `decideFill` can be verified as behaviour-preserving.
// Every case is driven end-to-end through the public API.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    createHarness,
    makeEntry,
    resetHarness,
    TEST_DB
} from "./helpers/formFillingHarness";

beforeEach(() => {
    document.body.innerHTML = "";
});
afterEach(resetHarness);

const LOGIN_FORM = `
    <form id="loginForm">
        <input id="user" name="username" type="text">
        <input id="pass" name="password" type="password">
        <button type="submit">Sign in</button>
    </form>`;

// entry whose field names match LOGIN_FORM
const goodEntry = (over = {}) =>
    makeEntry(
        [
            { type: "text", value: "alice", name: "username" },
            { type: "password", value: "s3cret", name: "password" }
        ],
        over
    );

describe("automated fill - single match", () => {
    it("#1 fills both fields, does not submit by default", () => {
        const h = createHarness(LOGIN_FORM);
        h.run([goodEntry()]);
        expect(h.fieldValue("user")).toBe("alice");
        expect(h.fieldValue("pass")).toBe("s3cret");
        expect(h.submitted().via).toBeNull();
    });

    it("#2 autoFillForms=false: not filled, but entries are still announced + icons added", () => {
        const h = createHarness(LOGIN_FORM);
        h.cfg().autoFillForms = false;
        h.run([goodEntry()]);
        expect(h.fieldValue("pass")).toBe("");
        expect(h.postedEntries()).toHaveLength(1);
        expect(h.keeFieldIcon.addKeeIconToFields).toHaveBeenCalledTimes(1);
    });

    it("#3 relevanceScore below threshold: not auto-filled (automated only)", () => {
        const h = createHarness(`
            <form id="loginForm">
                <input name="aaa" type="text" style="display:none">
                <input name="bbb" type="password" style="display:none">
            </form>`);
        h.run([goodEntry({ matchAccuracy: 0 })]);
        expect(h.fieldValue("bbb")).toBe(""); // present but not filled
        expect(h.matchResult().entries[0][0].relevanceScore).toBeLessThan(1);
        expect(
            h.logger.info.mock.calls.some(
                c => /not relevant enough|low field match ratio/.test(String(c[0]))
            )
        ).toBe(true);
    });

    it("#5 behaviour.autofillOnSuccess=false blocks the fill and sets cannotAutoFillForm", () => {
        const h = createHarness(LOGIN_FORM);
        h.scanWith({ autofillOnSuccess: false, autosubmitOnSuccess: false });
        h.deliverEntries([goodEntry()]);
        expect(h.fieldValue("pass")).toBe("");
        expect(h.matchResult().cannotAutoFillForm).toBe(true);
    });

    it("#6 plain scan leaves cannotAutoFillForm false (undefined is not === false)", () => {
        const h = createHarness(LOGIN_FORM);
        h.run([goodEntry()]);
        expect(h.matchResult().cannotAutoFillForm).toBe(false);
    });

    it("#7 a normally-scored single match clears the relevance threshold and fills", () => {
        // visible + names match -> ratio ok, matchAccuracy default -> score >= 1.
        // (The undefined/NaN-score case is covered by the decideFill unit tests.)
        const h = createHarness(LOGIN_FORM);
        h.run([goodEntry()]);
        expect(h.fieldValue("pass")).toBe("s3cret");
    });
});

describe("automated fill - multiple matches", () => {
    const two = () => [
        goodEntry({ uuid: "hi", matchAccuracy: 50 }),
        goodEntry({ uuid: "lo", matchAccuracy: 10, value: "other" })
    ];

    it("#8 default (autoFillFormsWithMultipleMatches=false): nothing filled, both announced", () => {
        const h = createHarness(LOGIN_FORM);
        h.run(two());
        expect(h.fieldValue("pass")).toBe("");
        expect(h.postedEntries()[0]).toHaveLength(2);
        expect(h.keeFieldIcon.addKeeIconToFields).toHaveBeenCalledTimes(1);
    });

    it("#9 autoFillFormsWithMultipleMatches=true: fills the higher-relevance entry", () => {
        const h = createHarness(LOGIN_FORM);
        h.cfg().autoFillFormsWithMultipleMatches = true;
        h.run([
            goodEntry({ uuid: "hi", name: "username", matchAccuracy: 50 }),
            makeEntry(
                [
                    { type: "text", value: "zzz", name: "username" },
                    { type: "password", value: "zzz", name: "password" }
                ],
                { uuid: "lo", matchAccuracy: 10 }
            )
        ]);
        expect(h.fieldValue("user")).toBe("alice");
    });

    it("#10 preferred entry wins over higher relevance", () => {
        const h = createHarness(LOGIN_FORM);
        h.cfg().autoFillFormsWithMultipleMatches = true;
        h.preferEntry("lo");
        h.run([
            goodEntry({ uuid: "hi", matchAccuracy: 50 }),
            makeEntry(
                [
                    { type: "text", value: "preferred", name: "username" },
                    { type: "password", value: "preferred", name: "password" }
                ],
                { uuid: "lo", matchAccuracy: 10 }
            )
        ]);
        expect(h.fieldValue("user")).toBe("preferred");
    });
});

describe("per-entry overrides - automated", () => {
    it("#12 neverAutoFill blocks an otherwise-allowed fill", () => {
        const h = createHarness(LOGIN_FORM);
        h.cfg().autoFillForms = true;
        h.run([goodEntry({ neverAutoFill: true })]);
        expect(h.fieldValue("pass")).toBe("");
    });

    it("#13 alwaysAutoFill fills even when autoFillForms=false", () => {
        const h = createHarness(LOGIN_FORM);
        h.cfg().autoFillForms = false;
        h.run([goodEntry({ alwaysAutoFill: true })]);
        expect(h.fieldValue("pass")).toBe("s3cret");
    });

    it("#13b alwaysAutoFill fills even with a low relevance / field match ratio", () => {
        // Same shape as #3 (invisible fields, matchAccuracy 0) - the automated
        // relevance threshold would normally reject this entry.
        const h = createHarness(`
            <form id="loginForm">
                <input id="user" name="aaa" type="text" style="display:none">
                <input id="pass" name="bbb" type="password" style="display:none">
            </form>`);
        h.run([
            makeEntry(
                [
                    { type: "text", value: "alice", name: "aaa" },
                    { type: "password", value: "s3cret", name: "bbb" }
                ],
                { matchAccuracy: 0, alwaysAutoFill: true }
            )
        ]);
        expect(h.fieldValue("bbb")).toBe("s3cret");
    });

    it("#14 alwaysAutoFill + neverAutoFill => not filled (never applied last)", () => {
        const h = createHarness(LOGIN_FORM);
        h.run([goodEntry({ alwaysAutoFill: true, neverAutoFill: true })]);
        expect(h.fieldValue("pass")).toBe("");
    });

    it("#15 alwaysAutoSubmit submits even when autoSubmitForms=false", () => {
        const h = createHarness(LOGIN_FORM);
        h.run([goodEntry({ alwaysAutoSubmit: true })]);
        expect(h.fieldValue("pass")).toBe("s3cret");
        expect(h.submitted().via).not.toBeNull();
    });

    it("#16 neverAutoSubmit suppresses submit even when autoSubmitForms=true", () => {
        const h = createHarness(LOGIN_FORM);
        h.cfg().autoSubmitForms = true;
        h.run([goodEntry({ neverAutoSubmit: true })]);
        expect(h.fieldValue("pass")).toBe("s3cret");
        expect(h.submitted().via).toBeNull();
    });

    it("#17 autoSubmitForms=true submits a plain automated fill", () => {
        const h = createHarness(LOGIN_FORM);
        h.cfg().autoSubmitForms = true;
        h.run([goodEntry()]);
        expect(h.submitted().via).not.toBeNull();
    });

    it("#18 behaviour.autosubmitOnSuccess=false blocks submit + sets cannotAutoSubmitForm", () => {
        const h = createHarness(LOGIN_FORM);
        h.cfg().autoSubmitForms = true;
        h.scanWith({ autosubmitOnSuccess: false });
        h.deliverEntries([goodEntry()]);
        expect(h.fieldValue("pass")).toBe("s3cret");
        expect(h.submitted().via).toBeNull();
        expect(h.matchResult().cannotAutoSubmitForm).toBe(true);
    });
});

describe("manual fill", () => {
    // seed: two entries, multi-match off => nothing auto-filled, entries recorded
    const seedTwo = (h: ReturnType<typeof createHarness>) =>
        h.run([
            goodEntry({ uuid: "e0" }),
            makeEntry(
                [
                    { type: "text", value: "second", name: "username" },
                    { type: "password", value: "second", name: "password" }
                ],
                { uuid: "e1" }
            )
        ]);

    it("#19 manualFill(1) fills the entry at the UNSORTED index", () => {
        const h = createHarness(LOGIN_FORM);
        seedTwo(h);
        h.manualFill(1);
        expect(h.fieldValue("user")).toBe("second");
    });

    it("#20 manualFill('1') - a string - behaves identically", () => {
        const h = createHarness(LOGIN_FORM);
        seedTwo(h);
        h.manualFill("1");
        expect(h.fieldValue("user")).toBe("second");
    });

    it("#21 manual fill ignores the relevance/ratio threshold", () => {
        const h = createHarness(`
            <form id="loginForm">
                <input id="user" name="aaa" type="text" style="display:none">
                <input id="pass" name="bbb" type="password" style="display:none">
            </form>`);
        h.run([goodEntry({ matchAccuracy: 0 })]); // auto path would reject
        h.manualFill(0);
        expect(h.fieldValue("pass")).toBe("s3cret");
    });

    it("#22 manual fill ignores neverAutoFill", () => {
        const h = createHarness(LOGIN_FORM);
        h.run([goodEntry({ neverAutoFill: true })]);
        h.manualFill(0);
        expect(h.fieldValue("pass")).toBe("s3cret");
    });

    it("#23 manual fill ignores autoFillForms=false", () => {
        const h = createHarness(LOGIN_FORM);
        h.cfg().autoFillForms = false;
        h.run([goodEntry()]);
        h.manualFill(0);
        expect(h.fieldValue("pass")).toBe("s3cret");
    });

    it("#24 manual fill does not auto-submit by default", () => {
        const h = createHarness(LOGIN_FORM);
        h.run([goodEntry()]);
        h.manualFill(0);
        expect(h.submitted().via).toBeNull();
    });

    it("#25 manual fill submits when autoSubmitMatchedForms=true", () => {
        const h = createHarness(LOGIN_FORM);
        h.cfg().autoSubmitMatchedForms = true;
        h.run([goodEntry()]);
        h.manualFill(0);
        expect(h.submitted().via).not.toBeNull();
    });

    it("#26 neverAutoSubmit blocks a manual submit when overrides are allowed", () => {
        const h = createHarness(LOGIN_FORM);
        h.cfg().autoSubmitMatchedForms = true;
        h.cfg().manualSubmitOverrideProhibited = false;
        h.run([goodEntry({ neverAutoSubmit: true })]);
        h.manualFill(0);
        expect(h.submitted().via).toBeNull();
    });

    it("#27 manualSubmitOverrideProhibited=true DISABLES the per-entry submit override [T5]", () => {
        const h = createHarness(LOGIN_FORM);
        h.cfg().autoSubmitMatchedForms = true;
        h.cfg().manualSubmitOverrideProhibited = true;
        h.run([goodEntry({ neverAutoSubmit: true })]);
        h.manualFill(0);
        expect(h.submitted().via).not.toBeNull();
    });

    it("#28 manual fill clears then re-syncs matchResult.UUID/dbFileName", () => {
        const h = createHarness(LOGIN_FORM);
        h.run([goodEntry({ uuid: "abc" })]);
        h.manualFill(0);
        expect(h.matchResult().UUID).toBe("abc");
        expect(h.matchResult().dbFileName).toBe(TEST_DB);
    });

    it("#29 manual fill does not re-announce entries or re-add icons", () => {
        const h = createHarness(LOGIN_FORM);
        h.run([goodEntry()]);
        const posts = h.postedEntries().length;
        const icons = h.keeFieldIcon.addKeeIconToFields.mock.calls.length;
        h.manualFill(0);
        expect(h.postedEntries().length).toBe(posts);
        expect(h.keeFieldIcon.addKeeIconToFields.mock.calls.length).toBe(icons);
    });

    it("#30 out-of-range manualFill index falls back to entry 0 [T1/B1]", () => {
        const h = createHarness(LOGIN_FORM);
        h.run([goodEntry()]);
        h.manualFill(5);
        expect(h.fieldValue("pass")).toBe("s3cret");
    });
});

describe("UUID-directed fill (scan behaviour.UUID)", () => {
    const e1 = () => goodEntry({ uuid: "e1", value: "one", matchAccuracy: 50 });
    const e2 = () =>
        makeEntry(
            [
                { type: "text", value: "two", name: "username" },
                { type: "password", value: "two", name: "password" }
            ],
            { uuid: "e2", matchAccuracy: 10 }
        );

    it("#32 fills the UUID-named entry even with autoFillForms=false", () => {
        const h = createHarness(LOGIN_FORM);
        h.cfg().autoFillForms = false;
        h.scanWith({ UUID: "e2", dbFileName: TEST_DB });
        h.deliverEntries([e1(), e2()]);
        expect(h.fieldValue("user")).toBe("two");
    });

    it("#33 unknown UUID: nothing filled, warns", () => {
        const h = createHarness(LOGIN_FORM);
        h.scanWith({ UUID: "nope", dbFileName: TEST_DB });
        h.deliverEntries([e1(), e2()]);
        expect(h.fieldValue("pass")).toBe("");
        expect(
            h.logger.warn.mock.calls.some(c =>
                /Could not find the required KeePass entry/.test(String(c[0]))
            )
        ).toBe(true);
    });

    it("#34 mustAutoSubmitForm from behaviour submits despite autoSubmitForms=false", () => {
        const h = createHarness(LOGIN_FORM);
        h.scanWith({ UUID: "e2", dbFileName: TEST_DB, mustAutoSubmitForm: true });
        h.deliverEntries([e1(), e2()]);
        expect(h.fieldValue("pass")).toBe("two");
        expect(h.submitted().via).not.toBeNull();
    });

    it("#35 UUID-directed fill on a single-entry form bypasses the relevance threshold [T3 fixed]", () => {
        // Invisible fields + matchAccuracy 0 => the automated relevance threshold
        // would reject this entry, but an explicit UUID request must not be gated.
        const h = createHarness(`
            <form id="loginForm">
                <input id="u" name="aaa" type="text" style="display:none">
                <input id="p" name="bbb" type="password" style="display:none">
            </form>`);
        h.scanWith({ UUID: "e1", dbFileName: TEST_DB });
        h.deliverEntries([
            makeEntry(
                [
                    { type: "text", value: "alice", name: "aaa" },
                    { type: "password", value: "s3cret", name: "bbb" }
                ],
                { uuid: "e1", matchAccuracy: 0 }
            )
        ]);
        expect(h.fieldValue("bbb")).toBe("s3cret");
    });

    it("#35b UUID-directed fill on a single-entry form fills nothing when the UUID is absent", () => {
        const h = createHarness(LOGIN_FORM);
        h.scanWith({ UUID: "not-here", dbFileName: TEST_DB });
        h.deliverEntries([goodEntry({ uuid: "e1" })]);
        expect(h.fieldValue("pass")).toBe("");
        expect(
            h.logger.warn.mock.calls.some(c =>
                /Could not find the required KeePass entry/.test(String(c[0]))
            )
        ).toBe(true);
    });
});

describe("form selection", () => {
    it("#36 picks the higher-scoring of two login forms, leaves the other alone", () => {
        const h = createHarness(`
            <form id="wrong"><input name="q" type="text"><input name="pin" type="password"></form>
            <form id="right"><input id="ru" name="username" type="text"><input id="rp" name="password" type="password"></form>`);
        h.run([goodEntry()]);
        expect(h.fieldValue("ru")).toBe("alice");
        expect(h.matchResult().mostRelevantFormIndex).toBe(1);
    });

    it("#31 manualFill(0, 1) targets the supplied formIndex", () => {
        const h = createHarness(`
            <form id="f0"><input id="u0" name="username" type="text"><input id="p0" name="password" type="password"></form>
            <form id="f1"><input id="u1" name="username" type="text"><input id="p1" name="password" type="password"></form>`);
        h.run([goodEntry()]);
        h.manualFill(0, 1);
        expect(h.matchResult().mostRelevantFormIndex).toBe(1);
        expect(h.fieldValue("p1")).toBe("s3cret");
    });
});

describe("stale-state / crash-path guards", () => {
    it("#40 fillAndSubmit before any scan is a no-op [T6 fixed]", () => {
        const h = createHarness(LOGIN_FORM);
        expect(() => h.manualFill(0)).not.toThrow();
        expect(h.fieldValue("pass")).toBe("");
        expect(h.formSaving.updateMatchResult).not.toHaveBeenCalled();
    });
});

describe("FormSaving contract (guards the FrameMatchState step)", () => {
    it("#42 updateMatchResult is called once with the live matchResult object", () => {
        const h = createHarness(LOGIN_FORM);
        h.run([goodEntry()]);
        expect(h.formSaving.updateMatchResult).toHaveBeenCalledTimes(1);
        expect(h.formSaving.updateMatchResult.mock.calls[0][0]).toBe(h.matchResult());
    });

    it("#43 a second fill keeps the same matchResult reference, updates lastFilled*", () => {
        const h = createHarness(LOGIN_FORM);
        h.run([goodEntry({ value: "first" })]);
        const ref = h.matchResult();
        h.manualFill(0);
        expect(h.matchResult()).toBe(ref);
        expect(ref.lastFilledPasswords.length).toBeGreaterThan(0);
    });

    it("#44 delivering entries twice does not replace the matchResult object", () => {
        const h = createHarness(LOGIN_FORM);
        h.scan();
        h.deliverEntries([goodEntry()]);
        const ref = h.matchResult();
        h.deliverEntries([goodEntry()]);
        expect(h.matchResult()).toBe(ref);
    });
});
