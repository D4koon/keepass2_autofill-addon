import { FilledField } from "./FilledField";
import { Entry } from "../common/model/Entry";
import { MatchedField } from "./MatchedField";
import type { FormFit } from "../common/model/FormFit";

export class MatchResult {
    entries: Entry[][];
    submitTargets: HTMLElement[];
    usernameIndexArray: number[];
    passwordFieldsArray: MatchedField[][];
    otherFieldsArray: MatchedField[][];
    allMatchingLogins: any[];
    // How each form does with its best-fitting entry (see formFit.ts)
    formFits: FormFit[];
    UUID: string;
    mustAutoFillForm: boolean;
    cannotAutoFillForm: boolean;
    mustAutoSubmitForm: boolean;
    cannotAutoSubmitForm: boolean;
    dbFileName: string;
    doc: Document;
    forms: HTMLFormElement[];
    formReadyForSubmit: boolean;
    autofillOnSuccess: boolean;
    autosubmitOnSuccess: boolean;
    mostRelevantFormIndex?: number;
    lastFilledOther: FilledField[];
    lastFilledPasswords: FilledField[];
}
