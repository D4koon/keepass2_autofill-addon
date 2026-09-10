import { describe, expect, it } from "vitest";
import { explainAutoFill, ExplainAutoFillContext } from "../common/model/AutoFillExplanation";
import { Entry } from "../common/model/Entry";

function entry(over: Partial<Entry> = {}): Entry {
    return new Entry({
        uuid: "e",
        relevanceScore: 40,
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

    it("alwaysAutoFill overrides the global disable (but still passes thresholds)", () => {
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

    it("low relevance blocks - even with alwaysAutoFill - on the automated path", () => {
        expect(explainAutoFill(entry({ relevanceScore: 0.4 }), ctx()).code).toBe("low-relevance");
        expect(
            explainAutoFill(entry({ relevanceScore: 0.4, alwaysAutoFill: true }), ctx()).code
        ).toBe("low-relevance");
    });

    it("an undefined relevance score is treated as too low", () => {
        expect(explainAutoFill(entry({ relevanceScore: undefined }), ctx()).code).toBe(
            "low-relevance"
        );
    });

    it("low field-match ratio blocks", () => {
        expect(explainAutoFill(entry({ lowFieldMatchRatio: true }), ctx()).code).toBe(
            "low-field-match"
        );
    });

    it("neverAutoFill blocks a match that otherwise passes", () => {
        expect(explainAutoFill(entry({ neverAutoFill: true }), ctx()).code).toBe("entry-never");
    });

    it("thresholds are not applied on a manual (non-automated) announce", () => {
        const r = explainAutoFill(
            entry({ relevanceScore: 0, lowFieldMatchRatio: true }),
            ctx({ automated: false })
        );
        expect(r).toEqual({ code: "fills-here", blocked: false });
    });
});
