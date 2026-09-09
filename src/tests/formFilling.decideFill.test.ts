// Direct unit tests for the pure decision helpers extracted from
// FormFilling.fillAndSubmit (src/page/fillDecision.ts). These run the auto vs.
// manual / relevance-threshold / multi-match / per-entry-override matrix without
// a DOM. The end-to-end characterization suite lives in
// formFilling.fillDecision.test.ts.
import { describe, expect, it, vi } from "vitest";
import {
    decideFill,
    resolveFillTarget,
    shouldAnnounceEntries,
    DecideFillInput
} from "../page/fillDecision";
import { Entry } from "../common/model/Entry";

type EntryOver = Partial<Entry>;
function entry(over: EntryOver = {}): Entry {
    return new Entry({
        uuid: over.uuid ?? "uuid-" + Math.random().toString(36).slice(2),
        relevanceScore: over.relevanceScore ?? 40,
        database: { fileName: "db.kdbx" } as Entry["database"],
        ...over
    });
}

type Cfg = DecideFillInput["config"];
function cfg(over: Partial<Cfg> = {}): Cfg {
    return {
        autoFillForms: true,
        autoFillFormsWithMultipleMatches: true,
        autoSubmitForms: false,
        autoSubmitMatchedForms: false,
        manualSubmitOverrideProhibited: false,
        ...over
    };
}

function baseInput(over: Partial<DecideFillInput> = {}): DecideFillInput {
    const entries = over.entriesForForm ?? [entry()];
    return {
        automated: true,
        isMatchedLoginRequest: false,
        entryIndex: undefined,
        entriesForForm: entries,
        orderedEntriesWithPreference: over.orderedEntriesWithPreference ?? entries,
        uuidHint: "",
        autofillOnSuccess: undefined as unknown as boolean,
        autosubmitOnSuccess: undefined as unknown as boolean,
        config: cfg(),
        ...over
    };
}

describe("resolveFillTarget", () => {
    it("automated call is never a matched-login request and asks for the best form", () => {
        const thunk = vi.fn(() => 3);
        const r = resolveFillTarget(
            { automated: true, currentMostRelevantFormIndex: null },
            thunk
        );
        expect(r.isMatchedLoginRequest).toBe(false);
        expect(thunk).toHaveBeenCalledTimes(1);
        expect(r.mostRelevantFormIndex).toBe(3);
    });

    it("manual call with formIndex + entryIndex is a matched-login request and does not call the thunk", () => {
        const thunk = vi.fn(() => 3);
        const r = resolveFillTarget(
            {
                automated: false,
                formIndex: 1,
                entryIndex: 0,
                currentMostRelevantFormIndex: null
            },
            thunk
        );
        expect(r.isMatchedLoginRequest).toBe(true);
        expect(thunk).not.toHaveBeenCalled();
        expect(r.mostRelevantFormIndex).toBe(1);
    });

    it("manual call relies on an already-known relevant form when no formIndex is given", () => {
        const thunk = vi.fn(() => 3);
        const r = resolveFillTarget(
            { automated: false, entryIndex: 0, currentMostRelevantFormIndex: 2 },
            thunk
        );
        expect(r.isMatchedLoginRequest).toBe(true);
        expect(thunk).not.toHaveBeenCalled();
        expect(r.mostRelevantFormIndex).toBe(2);
    });

    it("manual call without entryIndex falls back to the automated path", () => {
        const thunk = vi.fn(() => 3);
        const r = resolveFillTarget(
            { automated: false, formIndex: 1, currentMostRelevantFormIndex: 2 },
            thunk
        );
        expect(r.isMatchedLoginRequest).toBe(false);
        expect(thunk).toHaveBeenCalledTimes(1);
        // formIndex >= 0 still overrides the thunk result
        expect(r.mostRelevantFormIndex).toBe(1);
    });
});

describe("shouldAnnounceEntries", () => {
    it("announces on the automated path when there are entries", () => {
        expect(shouldAnnounceEntries(false, [entry()])).toBe(true);
    });
    it("does not announce for a matched-login request", () => {
        expect(shouldAnnounceEntries(true, [entry()])).toBe(false);
    });
    it("does not announce when there are no entries", () => {
        expect(shouldAnnounceEntries(false, [])).toBe(false);
    });
});

describe("decideFill - automated, single match", () => {
    it("fills a relevant single match using the global autoFillForms preference", () => {
        const e = entry({ relevanceScore: 40 });
        const d = decideFill(baseInput({ entriesForForm: [e], config: cfg({ autoFillForms: true }) }));
        expect(d.matchingLogin).toBe(e);
        expect(d.action).toEqual({ fill: true, submit: false });
        expect(d.cannotAutoFillForm).toBe(false);
        expect(d.clearUuid).toBe(false);
    });

    it("drops a single match whose relevance is below the threshold", () => {
        const d = decideFill(baseInput({ entriesForForm: [entry({ relevanceScore: 0.5 })] }));
        expect(d.matchingLogin).toBeNull();
        expect(d.logs.some(l => l.message.includes("not relevant enough"))).toBe(true);
    });

    it("drops a single match with a low field match ratio", () => {
        const d = decideFill(
            baseInput({ entriesForForm: [entry({ relevanceScore: 40, lowFieldMatchRatio: true })] })
        );
        expect(d.matchingLogin).toBeNull();
        expect(d.logs.some(l => l.message.includes("low field match ratio"))).toBe(true);
    });

    it("T4: an undefined relevanceScore passes the threshold (undefined < 1 is false)", () => {
        const e = entry({ relevanceScore: undefined });
        const d = decideFill(baseInput({ entriesForForm: [e] }));
        expect(d.matchingLogin).toBe(e);
    });

    it("respects autoSubmitForms for the automated path", () => {
        const d = decideFill(
            baseInput({ entriesForForm: [entry()], config: cfg({ autoSubmitForms: true }) })
        );
        expect(d.action.submit).toBe(true);
    });
});

describe("decideFill - behaviour gates", () => {
    it("automated + autofillOnSuccess === false blocks all fill decisions", () => {
        const d = decideFill(baseInput({ autofillOnSuccess: false, entriesForForm: [entry()] }));
        expect(d.cannotAutoFillForm).toBe(true);
        expect(d.matchingLogin).toBeNull();
        expect(d.action).toEqual({ fill: false, submit: false });
        expect(d.logs).toHaveLength(0);
    });

    it("automated + autosubmitOnSuccess === false only blocks submit", () => {
        const e = entry();
        const d = decideFill(baseInput({ autosubmitOnSuccess: false, entriesForForm: [e] }));
        expect(d.cannotAutoSubmitForm).toBe(true);
        expect(d.matchingLogin).toBe(e);
        expect(d.action.fill).toBe(true);
    });
});

describe("decideFill - automated, multiple matches", () => {
    const many = () => [
        entry({ uuid: "a", relevanceScore: 10 }),
        entry({ uuid: "b", relevanceScore: 40 })
    ];

    it("picks the first ordered entry and fills when multi-match fill is allowed", () => {
        const ordered = many();
        const d = decideFill(
            baseInput({
                entriesForForm: many(),
                orderedEntriesWithPreference: ordered,
                config: cfg({ autoFillFormsWithMultipleMatches: true })
            })
        );
        expect(d.matchingLogin).toBe(ordered[0]);
        expect(d.action.fill).toBe(true);
    });

    it("still selects an entry but does not fill when multi-match fill is disabled", () => {
        const ordered = many();
        const d = decideFill(
            baseInput({
                entriesForForm: many(),
                orderedEntriesWithPreference: ordered,
                config: cfg({ autoFillFormsWithMultipleMatches: false, autoFillForms: true })
            })
        );
        expect(d.matchingLogin).toBe(ordered[0]);
        expect(d.action.fill).toBe(false);
    });

    it("prefers the entry flagged isPreferredMatch", () => {
        const ordered = [
            entry({ uuid: "a", relevanceScore: 40 }),
            entry({ uuid: "b", relevanceScore: 10, isPreferredMatch: true })
        ];
        const d = decideFill(
            baseInput({ entriesForForm: many(), orderedEntriesWithPreference: ordered })
        );
        expect(d.matchingLogin).toBe(ordered[1]);
    });

    it("T7: the multi-match branch returns a clone, not the live entry object", () => {
        const live = many();
        const ordered = many();
        const d = decideFill(
            baseInput({ entriesForForm: live, orderedEntriesWithPreference: ordered })
        );
        expect(d.matchingLogin).toBe(ordered[0]);
        expect(d.matchingLogin).not.toBe(live[0]);
    });
});

describe("decideFill - entryIndex directed (matched-login request)", () => {
    const two = () => [entry({ uuid: "a" }), entry({ uuid: "b" })];

    it("selects entriesForForm[entryIndex], clears the uuid and forces fill", () => {
        const live = two();
        const d = decideFill(
            baseInput({
                automated: false,
                isMatchedLoginRequest: true,
                entryIndex: 1,
                entriesForForm: live,
                config: cfg({ autoFillForms: false })
            })
        );
        expect(d.matchingLogin).toBe(live[1]);
        expect(d.clearUuid).toBe(true);
        expect(d.action.fill).toBe(true); // isMatchedLoginRequest overrides autoFillForms
    });

    it("does not apply the relevance threshold on the entryIndex path", () => {
        const live = [entry({ uuid: "a", relevanceScore: 0 })];
        const d = decideFill(
            baseInput({
                automated: false,
                isMatchedLoginRequest: true,
                entryIndex: 0,
                entriesForForm: live
            })
        );
        expect(d.matchingLogin).toBe(live[0]);
    });

    it("does not apply per-entry fill overrides for a matched-login request", () => {
        const live = [entry({ uuid: "a", neverAutoFill: true })];
        const d = decideFill(
            baseInput({
                automated: false,
                isMatchedLoginRequest: true,
                entryIndex: 0,
                entriesForForm: live
            })
        );
        expect(d.action.fill).toBe(true);
    });

    it("uses autoSubmitMatchedForms (not autoSubmitForms) for a matched-login request", () => {
        const live = two();
        const d = decideFill(
            baseInput({
                automated: false,
                isMatchedLoginRequest: true,
                entryIndex: 0,
                entriesForForm: live,
                config: cfg({ autoSubmitForms: true, autoSubmitMatchedForms: false })
            })
        );
        expect(d.action.submit).toBe(false);
    });
});

describe("decideFill - UUID directed", () => {
    const three = () => [
        entry({ uuid: "a" }),
        entry({ uuid: "b" }),
        entry({ uuid: "c" })
    ];

    it("selects the entry whose uuid matches the hint and skips the threshold", () => {
        const live = three();
        const d = decideFill(
            baseInput({
                entriesForForm: live,
                orderedEntriesWithPreference: live,
                uuidHint: "c"
            })
        );
        expect(d.matchingLogin).toBe(live[2]);
        expect(d.clearUuid).toBe(false);
    });

    it("warns and selects nothing when the uuid hint is not present", () => {
        const live = three();
        const d = decideFill(
            baseInput({ entriesForForm: live, orderedEntriesWithPreference: live, uuidHint: "zzz" })
        );
        expect(d.matchingLogin).toBeNull();
        expect(d.logs.some(l => l.level === "warn")).toBe(true);
    });

    it("T3: a single-entry form takes the length==1 branch before the uuid branch", () => {
        const live = [entry({ uuid: "only", relevanceScore: 0.2 })];
        const d = decideFill(
            baseInput({
                entriesForForm: live,
                orderedEntriesWithPreference: live,
                uuidHint: "only"
            })
        );
        // threshold applied (automated) despite the uuid hint => dropped
        expect(d.matchingLogin).toBeNull();
        expect(d.logs.some(l => l.message.includes("not relevant enough"))).toBe(true);
    });
});

describe("decideFill - per-entry overrides (automated, non-matched)", () => {
    it("alwaysAutoFill forces fill even when autoFillForms is off", () => {
        const d = decideFill(
            baseInput({
                entriesForForm: [entry({ alwaysAutoFill: true })],
                config: cfg({ autoFillForms: false })
            })
        );
        expect(d.action.fill).toBe(true);
    });

    it("neverAutoFill blocks fill even when autoFillForms is on", () => {
        const d = decideFill(
            baseInput({
                entriesForForm: [entry({ neverAutoFill: true })],
                config: cfg({ autoFillForms: true })
            })
        );
        expect(d.action.fill).toBe(false);
    });

    it("alwaysAutoSubmit / neverAutoSubmit drive submit", () => {
        expect(
            decideFill(
                baseInput({ entriesForForm: [entry({ alwaysAutoSubmit: true })] })
            ).action.submit
        ).toBe(true);
        expect(
            decideFill(
                baseInput({
                    entriesForForm: [entry({ neverAutoSubmit: true })],
                    config: cfg({ autoSubmitForms: true })
                })
            ).action.submit
        ).toBe(false);
    });

    it("T5: manualSubmitOverrideProhibited disables per-entry submit overrides for a matched-login request", () => {
        const live = [entry({ uuid: "a", neverAutoSubmit: true })];
        const d = decideFill(
            baseInput({
                automated: false,
                isMatchedLoginRequest: true,
                entryIndex: 0,
                entriesForForm: live,
                config: cfg({ manualSubmitOverrideProhibited: true, autoSubmitMatchedForms: true })
            })
        );
        // neverAutoSubmit is ignored => submit stays at autoSubmitMatchedForms
        expect(d.action.submit).toBe(true);
    });

    it("T5 counterpart: with manualSubmitOverrideProhibited off the override applies", () => {
        const live = [entry({ uuid: "a", neverAutoSubmit: true })];
        const d = decideFill(
            baseInput({
                automated: false,
                isMatchedLoginRequest: true,
                entryIndex: 0,
                entriesForForm: live,
                config: cfg({ manualSubmitOverrideProhibited: false, autoSubmitMatchedForms: true })
            })
        );
        expect(d.action.submit).toBe(false);
    });
});
