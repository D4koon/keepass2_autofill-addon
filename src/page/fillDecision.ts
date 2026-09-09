import { Entry } from "../common/model/Entry";
import { Config } from "../common/config";

// The auto vs. manual / relevance-threshold / multi-match / per-entry-override
// decision logic, extracted verbatim from FormFilling.fillAndSubmit. These
// functions are pure: they make no DOM changes and mutate no shared state. The
// caller (fillAndSubmit) applies the returned data to matchResult and performs
// the actual DOM fill / submit.
//
// Behaviour is preserved 1:1, including several latent bugs that are only
// flagged with a TODO here, never fixed:
//
//  T2 (resolveFillTarget / decideFill): entryIndex can be a string ("1") at
//     runtime (MatchedLoginsPanel, commands.ts). `null >= 0` and `"1" >= 0` are
//     both true, so entryIndex is neither coerced with Number() nor typed as
//     number.
//  T3 (decideFill): the single-entry branch (entriesForForm.length == 1) is
//     tested before the UUID branch, so a UUID-directed fill against a
//     single-entry form ignores the UUID and applies the automated relevance
//     threshold.
//  T4 (decideFill): matchingLogin.relevanceScore can be undefined; `undefined <
//     1` is false, so such an entry passes the relevance test.
//  T5 (decideFill): manualSubmitOverrideProhibited === true DISABLES the
//     per-entry submit overrides on a manual fill (the name suggests the
//     opposite).
//  T7 (decideFill): the multi-match branch returns a clone from
//     orderedEntriesWithPreference, the other branches return the live object
//     from entriesForForm.

export interface FillAction {
    fill: boolean;
    submit: boolean;
}

export interface DecideFillLog {
    level: "debug" | "info" | "warn" | "error";
    message: string;
}

export interface FillTargetInput {
    automated: boolean;
    formIndex?: number;
    entryIndex?: number | string;
    // matchResult.mostRelevantFormIndex as it stands when fillAndSubmit is entered.
    currentMostRelevantFormIndex: number | null;
}

export interface FillTarget {
    isMatchedLoginRequest: boolean;
    mostRelevantFormIndex: number | null;
}

// Lines 1256-1268 of the original fillAndSubmit. getBestFormIndex is a thunk so
// getMostRelevantForm() (which logs) only runs on the non-matched-login path,
// exactly as before.
export function resolveFillTarget(
    input: FillTargetInput,
    getBestFormIndex: () => number
): FillTarget {
    const isMatchedLoginRequest =
        !input.automated &&
        ((input.currentMostRelevantFormIndex !== null &&
            input.currentMostRelevantFormIndex >= 0) ||
            typeof input.formIndex != "undefined") &&
        typeof input.entryIndex != "undefined";

    let mostRelevantFormIndex = input.currentMostRelevantFormIndex;

    if (!isMatchedLoginRequest) {
        mostRelevantFormIndex = getBestFormIndex();
    }

    // Supplied formIndex overrides any that we just automatically calculated above
    if (input.formIndex !== null && input.formIndex >= 0) {
        mostRelevantFormIndex = input.formIndex;
    }

    return { isMatchedLoginRequest, mostRelevantFormIndex };
}

// Whether fillAndSubmit announces the matches to the popup / adds the field
// icons. Line 1280-1282 of the original - the `.length` read is deliberately
// unguarded (throws today if entriesForForm is undefined, must keep throwing).
export function shouldAnnounceEntries(
    isMatchedLoginRequest: boolean,
    entriesForForm: Entry[]
): boolean {
    return !isMatchedLoginRequest && entriesForForm.length > 0;
}

type DecideFillConfig = Pick<
    Config,
    | "autoFillForms"
    | "autoFillFormsWithMultipleMatches"
    | "autoSubmitForms"
    | "autoSubmitMatchedForms"
    | "manualSubmitOverrideProhibited"
>;

export interface DecideFillInput {
    automated: boolean;
    isMatchedLoginRequest: boolean;
    entryIndex?: number | string;
    // matchResult.entries[mostRelevantFormIndex] - the live, scored entry objects.
    entriesForForm: Entry[];
    // sortMatchedEntries + flagUserPreferredEntry output - clones.
    orderedEntriesWithPreference: Entry[];
    // matchResult.UUID as it stands on entry to the decision block.
    uuidHint: string;
    // matchResult.autofillOnSuccess / autosubmitOnSuccess (from the scan behaviour).
    autofillOnSuccess: boolean;
    autosubmitOnSuccess: boolean;
    config: DecideFillConfig;
}

export interface FillDecision {
    isMatchedLoginRequest: boolean;
    cannotAutoFillForm: boolean;
    cannotAutoSubmitForm: boolean;
    matchingLogin: Entry | null;
    action: FillAction;
    // Today: matchResult.UUID / dbFileName are nulled when entryIndex >= 0.
    clearUuid: boolean;
    logs: DecideFillLog[];
}

// Lines 1297-1392 / 1445-1469 of the original fillAndSubmit.
export function decideFill(input: DecideFillInput): FillDecision {
    const logs: DecideFillLog[] = [];

    const cannotAutoFillForm =
        input.automated && input.autofillOnSuccess === false ? true : false;
    const cannotAutoSubmitForm =
        input.automated && input.autosubmitOnSuccess === false ? true : false;

    let matchingLogin: Entry = null;
    let action: FillAction = { fill: false, submit: false };
    let multipleMatches = false;
    let clearUuid = false;

    // No point looking at entry specific preferences if we are not allowed to auto-fill
    if (!cannotAutoFillForm) {
        logs.push({ level: "debug", message: "We are allowed to auto-fill this form." });

        // If we've been instructed to fill a specific entry, we need to select that
        // entry and clear any previously set information about an auto-filled entry
        // so it can be set correctly later.
        //
        // TODO (T2): entryIndex is not coerced. `null >= 0` and `"1" >= 0` are both
        // true at runtime, and entriesForForm["1"] indexes the array by string just
        // like entriesForForm[1]. The `as unknown as number` casts only keep the
        // compiler happy; the runtime value (possibly a string) is unchanged.
        let effectiveUuid = input.uuidHint;
        const entryIndexLoose = input.entryIndex as unknown as number;
        if (entryIndexLoose >= 0) {
            matchingLogin = input.entriesForForm[entryIndexLoose];
            clearUuid = true;
            effectiveUuid = null;
        }

        let checkMatchingLoginRelevanceThreshold = false;
        if (matchingLogin == null && input.entriesForForm.length == 1) {
            matchingLogin = input.entriesForForm[0];
            checkMatchingLoginRelevanceThreshold = true;
        } else if (
            effectiveUuid != undefined &&
            effectiveUuid != null &&
            effectiveUuid != ""
        ) {
            // Skip the relevance tests if we have been told to use a specific UUID
            logs.push({
                level: "debug",
                message: "We've been told to use an entry with this UUID: " + effectiveUuid
            });
            for (let count = 0; count < input.entriesForForm.length; count++) {
                if (input.entriesForForm[count].uuid == effectiveUuid) {
                    matchingLogin = input.entriesForForm[count];
                    break;
                }
            }
            if (matchingLogin == null) {
                logs.push({
                    level: "warn",
                    message:
                        "Could not find the required KeePass entry. Maybe the website redirected you to a different domain or hostname?"
                });
            }
        } else if (
            matchingLogin == null &&
            (!input.entriesForForm || !input.entriesForForm.length)
        ) {
            logs.push({ level: "debug", message: "No entries for form." });
        } else if (matchingLogin == null) {
            logs.push({
                level: "debug",
                message: "Multiple entries for form, so using preferred or most relevant."
            });
            matchingLogin =
                input.orderedEntriesWithPreference.find(e => e.isPreferredMatch) ||
                input.orderedEntriesWithPreference[0];
            multipleMatches = true;
            checkMatchingLoginRelevanceThreshold = true;
        }

        if (
            input.automated &&
            checkMatchingLoginRelevanceThreshold &&
            matchingLogin != null
        ) {
            if (matchingLogin.relevanceScore < 1) {
                logs.push({
                    level: "info",
                    message:
                        "Our selected entry is not relevant enough to exceed our threshold so will not be auto-filled."
                });
                matchingLogin = null;
            } else if (matchingLogin.lowFieldMatchRatio) {
                logs.push({
                    level: "info",
                    message:
                        "Our selected entry has a low field match ratio so will not be auto-filled."
                });
                matchingLogin = null;
            }
        }

        if (matchingLogin != null) {
            // Default auto-fill behaviour depends upon whether this is automatic or
            // manual, the corresponding user "automatic" option, if there are one or many matches
            // and the user option to prevent automatic fill due to multiple matches
            const autoFillEnabled =
                input.isMatchedLoginRequest ||
                (input.automated &&
                multipleMatches &&
                !input.config.autoFillFormsWithMultipleMatches
                    ? false
                    : input.config.autoFillForms);

            // Default auto-submit behaviour depends upon whether this is automatic or manual and the corresponding user option
            const autoSubmitEnabled = input.isMatchedLoginRequest
                ? input.config.autoSubmitMatchedForms
                : input.config.autoSubmitForms;

            action = { fill: autoFillEnabled, submit: autoSubmitEnabled };

            // Override fill preferences from per-entry configuration options
            // unless user explicity selected the matched entry
            if (!input.isMatchedLoginRequest) {
                if (matchingLogin.alwaysAutoFill) action.fill = true;
                if (matchingLogin.neverAutoFill) action.fill = false;
            }

            // Override submit preferences from per-entry configuration options
            if (!input.isMatchedLoginRequest || !input.config.manualSubmitOverrideProhibited) {
                if (matchingLogin.alwaysAutoSubmit) action.submit = true;
                if (matchingLogin.neverAutoSubmit) action.submit = false;
            }
        }
    }

    return {
        isMatchedLoginRequest: input.isMatchedLoginRequest,
        cannotAutoFillForm,
        cannotAutoSubmitForm,
        matchingLogin,
        action,
        clearUuid,
        logs
    };
}
