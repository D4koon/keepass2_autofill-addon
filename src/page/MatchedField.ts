import { Field } from "../common/model/Field";

export class MatchedField {
    field: Field;
    DOMelement: HTMLInputElement | HTMLSelectElement;
    // An entry stores this field's id or name (see formFit.ts); the field icons
    // go to such fields first
    matchesEntry?: boolean;
}
