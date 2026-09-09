import { FilledField } from "./FilledField";
import { MatchedField } from "./MatchedField";
import { Field } from "../common/model/Field";
import { configManager } from "../common/ConfigManager";
import { KeeLogger } from "../common/Logger";
import { FieldMatchScoreConfig, ScoringDeps, calculateFieldMatchScore } from "./relevanceScoring";

// Form-field population, extracted verbatim from FormFilling. The logger and the
// scoring deps are passed in; configManager is still imported directly (see the
// autoFillFieldsWithExistingValue note below).

interface ScoreMatrix {
    score: number;
    formFieldIndex: number;
    dataFieldIndex: number;
}

export interface FieldFillingDeps {
    logger: KeeLogger;
    scoringDeps: ScoringDeps;
}

function fillMatchedFields(
    fieldScoreMatrix: ScoreMatrix[],
    dataFields: Field[],
    formFields: MatchedField[],
    automated: boolean,
    deps: FieldFillingDeps
) {
    // We want to make sure each data field is matched to only one form field but we
    // don't know which field will be the best match and we don't want to ignore
    // less accurate matches just because they happen to appear later.

    // We have a matrix of objects representing each possible combination of data field
    // and form field and the score for that match.
    // We choose what to fill by sorting that list by score.
    // After filling a field we remove all objects from the list which are for the
    // data field we just filled in and the form field we filled in.

    // This means we always fill each form field only once, with the best match
    // selected from all data fields that haven't already been selected for another form field

    // The above algorithm could maybe be tweaked slightly in order to auto-fill
    // a "change password" form if we ever manage to make that automated

    // (score is reduced by one for each position we find in the form - this gives
    // a slight priority to fields at the top of a form which can be useful occasionally)

    fieldScoreMatrix.sort(function (a, b) {
        return b.score - a.score;
    });

    // Remember what we've filled in so we can make more accurate decisions when
    // the form is submitted later. We resist the urge the index by element ID or
    // the DOMelement itself because some websites do not specify an ID and some
    // may remove the DOMelement before we submit the form (sometimes under user
    // direction but occasionally automatically too)
    const filledFields: FilledField[] = [];

    // Keep filling in fields until we find no more with a positive score
    while (fieldScoreMatrix.length > 0 && fieldScoreMatrix[0].score > 0) {
        const ffi = fieldScoreMatrix[0].formFieldIndex;
        const dfi = fieldScoreMatrix[0].dataFieldIndex;
        const formField = formFields[ffi];
        const dataField = dataFields[dfi];
        const domElement = formField.DOMelement;

        const currentValue = getFormFieldCurrentValue(
            domElement,
            formField.field.locators[0].type
        );

        if (
            automated &&
            currentValue &&
            currentValue !== (domElement as any).keeInitialDetectedValue
        ) {
            deps.logger.info(
                "Not filling field because it's not empty and was edited by user since last load/fill"
            );
        } else if (
            automated &&
            currentValue &&
            // TODO: reads the live configManager.current (not FormFilling's frozen
            // this.config) - kept verbatim; the two can diverge after a config reload.
            !configManager.current.autoFillFieldsWithExistingValue
        ) {
            deps.logger.info(
                "Not filling field because it's not empty and user preference is to prevent automatic fill"
            );
        } else {
            deps.logger.info(
                "We will populate field " + ffi + " (id:" + formField.field.locators[0].id + ")"
            );
            fillASingleField(domElement, formField.field.locators[0].type, dataField.value);
        }

        filledFields.push({
            id: formField.field.locators[0].id,
            DOMelement: domElement,
            name: formField.field.locators[0].name,
            value: dataField.value
        });

        fieldScoreMatrix = fieldScoreMatrix.filter(function (element) {
            return element.dataFieldIndex != dfi && element.formFieldIndex != ffi;
        });

        fieldScoreMatrix.sort(function (a, b) {
            return b.score - a.score;
        });
    }
    return filledFields;
}

function getFormFieldCurrentValue(
    domElement: HTMLInputElement | HTMLSelectElement,
    fieldType: string
) {
    let currentValue = domElement.value;
    if (domElement instanceof HTMLInputElement && fieldType === "checkbox") {
        if (domElement.checked) {
            currentValue = "KEEFOX_CHECKED_FLAG_TRUE";
        } else {
            currentValue = "KEEFOX_CHECKED_FLAG_FALSE";
        }
    }
    return currentValue;
}

function fillASingleField(
    domElement: HTMLInputElement | HTMLSelectElement,
    fieldType: string,
    value: string
) {
    if (fieldType == "select-one") {
        domElement.value = value;
    } else if (domElement instanceof HTMLInputElement && fieldType == "checkbox") {
        if (value == "KEEFOX_CHECKED_FLAG_TRUE") domElement.checked = true;
        else domElement.checked = false;
    } else if (domElement instanceof HTMLInputElement && fieldType == "radio") {
        domElement.checked = true;
    } else {
        domElement.value = value;
    }

    //TODO:5: Investigate and document why we're not using data attributes to store this string in the DOM
    (domElement as any).keeInitialDetectedValue = value;

    // input/change are plain Events (not UIEvents); site frameworks read
    // event.target.value, never event.view.
    domElement.dispatchEvent(new Event("input", { bubbles: true, cancelable: true }));
    domElement.dispatchEvent(new Event("change", { bubbles: true, cancelable: true }));
}

export function fillManyFormFields(
    formFields: MatchedField[],
    dataFields: Field[],
    currentPage,
    scoreConfig: FieldMatchScoreConfig,
    automated: boolean,
    deps: FieldFillingDeps
) {
    deps.logger.debug("_fillManyFormFields started");

    if (
        formFields == null ||
        formFields == undefined ||
        dataFields == null ||
        dataFields == undefined
    ) {
        return;
    }

    deps.logger.debug("We've received the data we need");

    deps.logger.info("Filling form fields for page " + currentPage);

    // we try to fill every form field. We try to match by id first and then name before just guessing.
    // Generally we'll only fill if the matched field is of the same type as the form field but
    // we are flexible RE text and username fields because that's an artificial difference
    // for the sake of the Kee password management software. However, usernames will be chosen above
    // text fields if all else is equal
    const fieldScoreMatrix = [];

    for (let i = 0; i < formFields.length; i++) {
        for (let j = 0; j < dataFields.length; j++) {
            const score = calculateFieldMatchScore(
                formFields[i],
                dataFields[j],
                currentPage,
                scoreConfig,
                deps.scoringDeps
            );
            deps.logger.debug(
                "Suitability of putting data field " +
                    j +
                    " into form field " +
                    i +
                    " (id: " +
                    formFields[i].field.locators[0].id +
                    ") is " +
                    score
            );
            fieldScoreMatrix.push({
                score: score,
                dataFieldIndex: j,
                formFieldIndex: i
            });
        }
    }

    return fillMatchedFields(fieldScoreMatrix, dataFields, formFields, automated, deps);
}
