import { FilledField } from "./FilledField";
import { MatchedField } from "./MatchedField";
import { Field } from "../common/model/Field";
import { configManager } from "../common/ConfigManager";
import { KeeLogger } from "../common/Logger";
import { ScoringDeps } from "./pageDeps";
import { findCandidates, pairFields } from "./fieldRanking";

// Form-field population, extracted from FormFilling. Which page field gets
// which entry field is decided in fieldRanking.ts. configManager is still
// imported directly (see the autoFillFieldsWithExistingValue note below).

export interface FieldFillingDeps {
    logger: KeeLogger;
    scoringDeps: ScoringDeps;
    // Whether something else on the page lies over the field (see fieldCover.ts)
    isCoveredBySite(element: HTMLElement): boolean;
}

function fillMatchedFields(
    dataFields: Field[],
    formFields: MatchedField[],
    automated: boolean,
    deps: FieldFillingDeps,
    usernameIndex?: number
) {
    // Each entry field goes to one page field and each page field gets at most
    // one entry field: the best pair first, then the best of what is left.
    const picks = pairFields(
        findCandidates(formFields, dataFields, usernameIndex, {
            isVisible: el => deps.scoringDeps.isDOMElementVisible(el),
            isCoveredBySite: el => deps.isCoveredBySite(el)
        })
    );

    // Remember what we've filled in so we can make more accurate decisions when
    // the form is submitted later. We resist the urge the index by element ID or
    // the DOMelement itself because some websites do not specify an ID and some
    // may remove the DOMelement before we submit the form (sometimes under user
    // direction but occasionally automatically too)
    const filledFields: FilledField[] = [];

    for (const { winner } of picks) {
        const ffi = winner.formFieldIndex;
        const dfi = winner.dataFieldIndex;
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
    automated: boolean,
    deps: FieldFillingDeps,
    // The page field guessed to take the username (FormUtils.pickUsernameIndex)
    usernameIndex?: number
) {
    if (formFields == null || dataFields == null) return;
    deps.logger.info("Filling form fields");
    return fillMatchedFields(dataFields, formFields, automated, deps, usernameIndex);
}
