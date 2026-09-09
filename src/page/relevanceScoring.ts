import { MatchedField } from "./MatchedField";
import { Field } from "../common/model/Field";
import { Entry } from "../common/model/Entry";
import { KeeLogger } from "../common/Logger";

// Field- and entry-level relevance scoring, extracted verbatim from FormFilling.
// Pure apart from one deliberate side effect: determineRelevanceScores writes
// `matchedField.highestScore`, which KeeFieldIcon later reads to order the icons.

export class FieldMatchScoreConfig {
    punishWrongIDAndName: boolean;
}

export class VisibleFieldCache {
    password: boolean[];
    other: boolean[];
}

export interface ScoringDeps {
    isDOMElementVisible(element: HTMLElement): boolean;
    logger: KeeLogger;
}

export function calculateFieldMatchScore(
    matchedField: MatchedField,
    dataField: Field,
    _currentPage, //TODO:5: remove param
    config: FieldMatchScoreConfig,
    deps: ScoringDeps,
    isVisible?: boolean
) {
    const formField = matchedField.field;
    // Default score is 1 so that bad matches which are at least the correct type
    // have a chance of being selected if no good matches are found
    let score = 1;

    // Do not allow any match if field types are significantly mismatched (e.g. checkbox vs text field)
    if (formField.type !== dataField.type) return 0;

    // score += this.calculateLabelMatchScore(matchedField, dataField);

    // If field IDs match +++++
    if (
        formField.locators[0].id != null &&
        formField.locators[0].id != undefined &&
        formField.locators[0].id != "" &&
        formField.locators[0].id == dataField.locators[0].id
    ) {
        score += 50;
    } else if (config.punishWrongIDAndName && dataField.locators[0].id) {
        score -= 5;
    }

    // If field names match ++++
    // (We do not treat ID and NAME as mutually exclusive because some badly written
    // websites might have duplicate IDs but different names so this combined approach
    // might allow them to work correctly)
    if (
        formField.locators[0].name != null &&
        formField.locators[0].name != undefined &&
        formField.locators[0].name != "" &&
        formField.locators[0].name == dataField.locators[0].name
    ) {
        score += 40;
    } else if (config.punishWrongIDAndName && dataField.locators[0].name) {
        score -= 5;
    }

    // Radio buttons have their values set by the website and hence can provide
    // a useful cue when both id and name matching fails
    if (
        formField.locators[0].type === "radio" &&
        formField.value != null &&
        formField.value != undefined &&
        formField.value != "" &&
        formField.value == dataField.value
    ) {
        score += 30;
    }

    if (isVisible === undefined && deps.isDOMElementVisible(matchedField.DOMelement)) {
        isVisible = true;
    }

    score += isVisible ? 35 : 0;

    return score;
}

export function calculateRelevanceScore(
    entry: Entry,
    passwordFields: MatchedField[],
    otherFields: MatchedField[],
    currentPage: number,
    formVisible: boolean,
    scoreConfig: FieldMatchScoreConfig,
    visibleFieldCache: VisibleFieldCache,
    deps: ScoringDeps
) {
    let score = 0;
    let lowFieldMatchRatio = false;

    // Kee 3.4+ no longer considers priority overrides because they were
    // complicated and unreliable even when fully understood.

    // Kee 1.5+ no longer considers action URLs in relevance weighting. Since the only
    // entry entries of interest are already pre-matched by KeePass, this should have been
    // adding negligable accuracy to the form matching.

    score += entry.matchAccuracy;

    // Punish but don't entirely exclude matches against invisible forms
    // This is in addition to the maximum score of invisible fields being limited
    // so that forms with some visible fields but invisible username/password
    // fields (or our best guess at them anyway) are considered a less likely match
    if (!formVisible) score -= 20;

    // This is similar to _fillManyFormFields so might be able to reuse the results in future
    // (but need to watch for changes that invalidate the earlier calculations).

    // Require at least a type match for 2-field forms (e.g. user/pass); 1 missing
    // match for 3 or 4 field forms; etc.
    const minMatchedFieldCountRatio = 0.501;

    const [otherRelevanceScore, otherFieldMatchSuccesses] = determineRelevanceScores(
        "other",
        otherFields,
        entry.fields.filter(f => f.type !== "password"),
        currentPage,
        scoreConfig,
        visibleFieldCache.other,
        deps
    );
    const [passwordRelevanceScore, passwordFieldMatchSuccesses] = determineRelevanceScores(
        "password",
        passwordFields,
        entry.fields.filter(f => f.type === "password"),
        currentPage,
        scoreConfig,
        visibleFieldCache.password,
        deps
    );

    const totalRelevanceScore = otherRelevanceScore + passwordRelevanceScore;

    // Only consider fields that can ever match above the minimum (essentially
    // ignore empty form or entry fields). Will underestimate number of form
    // fields, resulting in increased match ratio and less accurate relevancy
    // scores for forms that contain a username/password field with no name
    // or id attributes. No idea if this will cause a problem. Seems to.
    // Mitigating by adjusting min relevancy values, etc. so can remove
    // this comment in a few versions if all is good.
    // v3.5 still not good. Have fixed a visibility bug, which exacerbates
    // some other bugs. Will try ignoring non-text/password fields in ratio
    // calculation for autofill (can extend to form selection calculation later if good)
    const formFieldCount = passwordFields
        .concat(otherFields)
        .filter(f => f.field.locators[0].id || f.field.locators[0].name || f.field.value).length;
    const loginFieldCount = entry.fields.filter(
        f => f.locators[0].id || f.locators[0].name || f.value
    ).length;
    const formFieldCountForAutofill = passwordFields
        .concat(otherFields)
        .filter(
            f =>
                (f.field.type === "password" || f.field.type === "text") &&
                (f.field.locators[0].id || f.field.locators[0].name)
        ).length;
    const loginFieldCountForAutofill = entry.fields.filter(
        f =>
            (f.type === "password" || f.type === "text") &&
            (f.locators[0].id || f.locators[0].name || f.value)
    ).length;

    const formMatchedFieldCountForAutofill =
        otherFieldMatchSuccesses.filter(s => s === true).length +
        passwordFieldMatchSuccesses.filter(s => s === true).length;

    const numberOfNewPasswordFields = passwordFields.filter(f =>
        f.field.locators[0].autocompleteValues?.some(v => v === "new-password")
    ).length;

    // Limiting to number of entry fields will reduce false positives but
    //increase chance of a valid form being missed.
    // To help with password changing, we treat any known "new password" fields as an automatic match
    const fieldMatchRatioForAutofill =
        Math.min(
            loginFieldCountForAutofill + numberOfNewPasswordFields,
            formMatchedFieldCountForAutofill
        ) / Math.max(1, formFieldCountForAutofill);

    deps.logger.debug(
        "formFieldCount: " +
            formFieldCount +
            ", loginFieldCount: " +
            loginFieldCount +
            ", loginFieldCountForAutofill: " +
            loginFieldCountForAutofill +
            ", formFieldCountForAutofill: " +
            formFieldCountForAutofill +
            ", formMatchedFieldCountForAutofill: " +
            formMatchedFieldCountForAutofill +
            ", numberOfNewPasswordFields: " +
            numberOfNewPasswordFields +
            ", fieldMatchRatio: " +
            fieldMatchRatioForAutofill
    );

    if (fieldMatchRatioForAutofill < minMatchedFieldCountRatio) {
        deps.logger.info(
            entry.uuid +
                " will be forced to not auto-fill because the form field match ratio (" +
                fieldMatchRatioForAutofill +
                ") is not high enough."
        );
        lowFieldMatchRatio = true;
    }

    const averageFieldRelevance = totalRelevanceScore / Math.max(formFieldCount, loginFieldCount);
    const adjustedRelevance =
        averageFieldRelevance / (Math.abs(formFieldCount - loginFieldCount) + 1);

    score += adjustedRelevance;

    deps.logger.info("Relevance for " + entry.uuid + " is: " + score);
    return { score: score, lowFieldMatchRatio: lowFieldMatchRatio };
}

export function determineRelevanceScores(
    debugName: string,
    matchedFields: MatchedField[],
    entryFields: Field[],
    currentPage: number,
    scoreConfig: FieldMatchScoreConfig,
    visibleFieldMap: boolean[],
    deps: ScoringDeps
): [number, boolean[]] {
    let totalRelevanceScore = 0;
    const minFieldRelevance = 1;
    const fieldMatchSuccesses: boolean[] = [];

    for (let i = 0; i < matchedFields.length; i++) {
        let mostRelevantScore = 0;
        const formField = matchedFields[i].field;

        if (formField.locators[0].autocompleteValues?.some(v => v === "new-password")) {
            // Record as a successful match for the purposes of match ratio calculations
            // if this is a new password field as part of a change password form. So we
            // don't affect the selection of the form or entry to fill but when all
            // else is equal, we will have a higher chance of auto-filling the existing
            // user name and password fields.
            fieldMatchSuccesses[i] = true;
        }

        for (let j = 0; j < entryFields.length; j++) {
            const fmScore = calculateFieldMatchScore(
                matchedFields[i],
                entryFields[j],
                currentPage,
                scoreConfig,
                deps,
                visibleFieldMap[i]
            );
            deps.logger.debug(
                "Suitability of putting " +
                    debugName +
                    " field " +
                    j +
                    " into form field " +
                    i +
                    " (id: " +
                    formField.locators[0].id +
                    ") is " +
                    fmScore
            );
            if (fmScore > mostRelevantScore) {
                mostRelevantScore = fmScore;
            }
            const fmScoreForRatio = fmScore - (visibleFieldMap[i] ? 0 : 10);
            if (
                (formField.type === "text" || formField.type === "password") &&
                fmScoreForRatio >= minFieldRelevance &&
                entryFields[j].value &&
                !fieldMatchSuccesses[i]
            ) {
                fieldMatchSuccesses[i] = true;
            }
            if (
                matchedFields[i].highestScore == null ||
                fmScore > matchedFields[i].highestScore
            ) {
                matchedFields[i].highestScore = fmScore;
            }
        }
        totalRelevanceScore += mostRelevantScore;
    }
    return [totalRelevanceScore, fieldMatchSuccesses];
}
