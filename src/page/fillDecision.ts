import { Entry } from "../common/model/Entry";
import { Config } from "../common/config";

// The auto vs. manual / relevance-threshold / multi-match / per-entry-override
// decision logic, extracted from FormFilling.fillAndSubmit. These functions are
// pure: they make no DOM changes and mutate no shared state. The caller
// (fillAndSubmit) applies the returned data to matchResult and performs the
// actual DOM fill / submit.
//
// Note on manualSubmitOverrideProhibited: when true (settings checkbox
// "Editing the Auto-submit behaviour of an entry also overrides this behaviour"
// UNticked), a manual fill ignores the entry's alwaysAutoSubmit / neverAutoSubmit
// flags. That is the documented meaning of the option, not a bug.

// entryIndex reaches us as a number (popup, executePrimaryAction), a numeric
// string (context menu, in-page matched-logins panel), or nothing. Return the
// non-negative integer index, or null for "no explicit entry was chosen" -
// including undefined, null, "", and non-numeric or negative values. Avoids the
// `null >= 0 === true` / `"1" >= 0 === true` traps of a bare comparison.
function parseEntryIndex(value: number | string | null | undefined): number | null {
    const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
    return typeof n === "number" && Number.isInteger(n) && n >= 0 ? n : null;
}

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
    entryIndex?: number | string | null;
    // matchResult.mostRelevantFormIndex as it stands when fillAndSubmit is entered.
    currentMostRelevantFormIndex: number | null;
}

export interface FillTarget {
    isMatchedLoginRequest: boolean;
    mostRelevantFormIndex: number | null;
}

// getBestFormIndex is a thunk so getMostRelevantForm() (which logs) only runs on
// the non-matched-login path.
export function resolveFillTarget(
    input: FillTargetInput,
    getBestFormIndex: () => number
): FillTarget {
    const isMatchedLoginRequest =
        !input.automated &&
        ((input.currentMostRelevantFormIndex !== null &&
            input.currentMostRelevantFormIndex >= 0) ||
            typeof input.formIndex != "undefined") &&
        parseEntryIndex(input.entryIndex) !== null;

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
// icons. entriesForForm is matchResult.entries[formIndex], which scanFrameForForms
// always initialises to [] for a scanned frame.
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
    // A number, a numeric string, or nothing - see parseEntryIndex.
    entryIndex?: number | string | null;
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
    // Caller nulls matchResult.UUID / dbFileName - set when an explicit entryIndex
    // was chosen, so the fill's own UUID sync can run afterwards.
    clearUuid: boolean;
    logs: DecideFillLog[];
}

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

        // If we've been instructed to fill a specific entry by index, select it
        // and clear any previously recorded auto-filled entry so it can be set
        // correctly later. An explicit index wins over the UUID hint.
        let effectiveUuid = input.uuidHint;
        const explicitEntryIndex = parseEntryIndex(input.entryIndex);
        if (explicitEntryIndex !== null) {
            matchingLogin = input.entriesForForm[explicitEntryIndex];
            clearUuid = true;
            effectiveUuid = null;
        }

        const haveUuidHint =
            effectiveUuid != undefined && effectiveUuid != null && effectiveUuid != "";

        let checkMatchingLoginRelevanceThreshold = false;
        if (matchingLogin == null && haveUuidHint) {
            // A specific UUID was requested: use exactly that entry (skipping the
            // relevance threshold) or nothing. Checked before the single-entry
            // branch so a one-entry form does not silently ignore the UUID.
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
        } else if (matchingLogin == null && input.entriesForForm.length == 1) {
            matchingLogin = input.entriesForForm[0];
            checkMatchingLoginRelevanceThreshold = true;
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
            const picked =
                input.orderedEntriesWithPreference.find(e => e.isPreferredMatch) ||
                input.orderedEntriesWithPreference[0];
            // orderedEntriesWithPreference are sort/flag clones; return the live
            // scored entry, consistent with the other branches.
            matchingLogin =
                (picked && input.entriesForForm.find(e => e.uuid === picked.uuid)) || picked;
            multipleMatches = true;
            checkMatchingLoginRelevanceThreshold = true;
        }

        if (
            input.automated &&
            checkMatchingLoginRelevanceThreshold &&
            matchingLogin != null
        ) {
            if (!(matchingLogin.relevanceScore >= 1)) {
                // >= 1 rather than < 1 so a missing / NaN score also fails.
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
