import type { Entry } from "./Entry";
import type { Config } from "../config";

// A short, structured explanation of whether Kee will auto-fill a given matched
// entry on the current page - and if not, why not. Computed by the content
// script when it announces the matches and rendered per entry in the popup.

export type AutoFillExplanationCode =
    | "fills-here" // will be / was auto-filled
    | "autofill-disabled" // the global "auto-fill forms" setting is off
    | "context-notify-only" // this scan was told to list matches only, not fill
    | "multiple-matches" // more than one entry matches and multi-match fill is off
    | "entry-never" // the entry is flagged "never auto-fill" in the database
    | "no-login-field" // no visible password field, nor a username field on a first step
    | "sign-up-form" // looks like a sign-up or change-password form
    | "extra-fields"; // more text fields the entry has nothing for than a login has

export interface AutoFillExplanation {
    code: AutoFillExplanationCode;
    blocked: boolean;
    // Only set for "multiple-matches".
    matchCount?: number;
    // Only set for "extra-fields": names or labels of those fields
    fields?: string[];
}

export interface ExplainAutoFillContext {
    // True for an automatic page-load / rescan fill attempt, false for a manual one.
    automated: boolean;
    // matchResult.autofillOnSuccess === false on an automated attempt.
    cannotAutoFillForm: boolean;
    // Number of entries matched to this form.
    matchCount: number;
    config: Pick<Config, "autoFillForms" | "autoFillFormsWithMultipleMatches">;
}

// Mirrors the gating order in FormFilling.fillAndSubmit / decideFill closely
// enough to explain the outcome. The first applicable reason wins.
export function explainAutoFill(
    entry: Entry,
    ctx: ExplainAutoFillContext
): AutoFillExplanation {
    const always = !!entry.alwaysAutoFill;
    const never = !!entry.neverAutoFill;

    if (ctx.automated && ctx.cannotAutoFillForm) {
        return { code: "context-notify-only", blocked: true };
    }

    // alwaysAutoFill overrides the global setting, the multi-match hold, and the
    // form checks below - but not neverAutoFill (checked
    // last, regardless of always).
    if (!always) {
        if (!ctx.config.autoFillForms) {
            return { code: "autofill-disabled", blocked: true };
        }
        if (ctx.matchCount > 1 && !ctx.config.autoFillFormsWithMultipleMatches) {
            return { code: "multiple-matches", blocked: true, matchCount: ctx.matchCount };
        }
        // An entry that wasn't checked against the form isn't filled either
        const blocker = entry.formFit ? entry.formFit.blocker : { code: "no-login-field" as const };
        if (ctx.automated && blocker) {
            return blocker.code === "extra-fields"
                ? { code: blocker.code, blocked: true, fields: blocker.fields }
                : { code: blocker.code, blocked: true };
        }
    }

    if (never) {
        return { code: "entry-never", blocked: true };
    }

    return { code: "fills-here", blocked: false };
}
