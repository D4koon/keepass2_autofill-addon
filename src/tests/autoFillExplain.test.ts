import { describe, expect, it } from "vitest";
import { explainAutoFill, ExplainAutoFillContext } from "../common/model/AutoFillExplanation";
import { Entry } from "../common/model/Entry";
import type { FormFit } from "../common/model/FormFit";

// How an entry fits a plain login form, and ones it isn't filled on by itself
const FITS: FormFit = { loginField: "password", storedMatches: 0, blocker: null };
const NO_LOGIN: FormFit = { loginField: null, storedMatches: 0, blocker: { code: "no-login-field" } };
const EXTRA: FormFit = {
    loginField: "password",
    storedMatches: 0,
    blocker: { code: "extra-fields", fields: ["First name", "Street"] }
};

function entry(over: Partial<Entry> = {}): Entry {
    return new Entry({
        uuid: "e",
        formFit: FITS,
        database: { fileName: "db.kdbx" } as Entry["database"],
        ...over
    });
}

function ctx(over: Partial<ExplainAutoFillContext> = {}): ExplainAutoFillContext {
    return {
        automated: true,
        cannotAutoFillForm: false,
        matchCount: 1,
        config: { autoFillForms: true, autoFillFormsWithMultipleMatches: false },
        ...over
    };
}

describe("explainAutoFill", () => {
    it("a strong single automated match fills here", () => {
        const r = explainAutoFill(entry(), ctx());
        expect(r).toEqual({ code: "fills-here", blocked: false });
    });

    it("notify-only context wins over everything", () => {
        const r = explainAutoFill(
            entry({ alwaysAutoFill: true }),
            ctx({ cannotAutoFillForm: true })
        );
        expect(r).toEqual({ code: "context-notify-only", blocked: true });
    });

    it("auto-fill disabled globally", () => {
        const r = explainAutoFill(entry(), ctx({ config: { autoFillForms: false, autoFillFormsWithMultipleMatches: false } }));
        expect(r.code).toBe("autofill-disabled");
        expect(r.blocked).toBe(true);
    });

    it("alwaysAutoFill overrides the global disable", () => {
        const r = explainAutoFill(
            entry({ alwaysAutoFill: true }),
            ctx({ config: { autoFillForms: false, autoFillFormsWithMultipleMatches: false } })
        );
        expect(r).toEqual({ code: "fills-here", blocked: false });
    });

    it("multiple matches with multi-match fill off", () => {
        const r = explainAutoFill(entry(), ctx({ matchCount: 3 }));
        expect(r).toEqual({ code: "multiple-matches", blocked: true, matchCount: 3 });
    });

    it("multiple matches but multi-match fill on => fills here", () => {
        const r = explainAutoFill(
            entry(),
            ctx({ matchCount: 3, config: { autoFillForms: true, autoFillFormsWithMultipleMatches: true } })
        );
        expect(r.code).toBe("fills-here");
    });

    it("alwaysAutoFill overrides the multi-match hold", () => {
        const r = explainAutoFill(entry({ alwaysAutoFill: true }), ctx({ matchCount: 5 }));
        expect(r.code).toBe("fills-here");
    });

    it("a form without a login field blocks a plain entry", () => {
        expect(explainAutoFill(entry({ formFit: NO_LOGIN }), ctx()).code).toBe("no-login-field");
    });

    it("an entry not checked against the form is not filled either", () => {
        expect(explainAutoFill(entry({ formFit: undefined }), ctx()).code).toBe("no-login-field");
    });

    it("names the fields the entry has nothing for", () => {
        expect(explainAutoFill(entry({ formFit: EXTRA }), ctx())).toEqual({
            code: "extra-fields",
            blocked: true,
            fields: ["First name", "Street"]
        });
    });

    it("alwaysAutoFill overrides the form checks", () => {
        expect(explainAutoFill(entry({ alwaysAutoFill: true, formFit: NO_LOGIN }), ctx()).code).toBe(
            "fills-here"
        );
        expect(explainAutoFill(entry({ alwaysAutoFill: true, formFit: EXTRA }), ctx()).code).toBe(
            "fills-here"
        );
    });

    it("neverAutoFill blocks a match that otherwise passes", () => {
        expect(explainAutoFill(entry({ neverAutoFill: true }), ctx()).code).toBe("entry-never");
    });

    it("neverAutoFill still wins when alwaysAutoFill is also set", () => {
        const r = explainAutoFill(
            entry({ alwaysAutoFill: true, neverAutoFill: true, formFit: NO_LOGIN }),
            ctx()
        );
        expect(r.code).toBe("entry-never");
    });

    it("form checks are not applied on a manual (non-automated) announce", () => {
        const r = explainAutoFill(entry({ formFit: EXTRA }), ctx({ automated: false }));
        expect(r).toEqual({ code: "fills-here", blocked: false });
    });
});
