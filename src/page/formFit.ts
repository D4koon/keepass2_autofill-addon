import { Entry } from "../common/model/Entry";
import { Field } from "../common/model/Field";
import { MatchedField } from "./MatchedField";
import type { FitBlocker, FormFit } from "../common/model/FormFit";
import { CandidateDeps, Reach, findCandidates, pairFields, reachOf } from "./fieldRanking";

// How well an entry fits a login form, in plain facts rather than points:
// which form to fill when a page has several, in which order to offer the
// entries, and whether an entry may be filled without a click. See
// docs/form-filling.adoc.

export type { FitBlocker, FormFit };

// Text fields the entry has nothing for that a login may still have, such as
// a captcha. A sign-up or profile form has more.
export const MAX_EXTRA_FIELDS = 1;

interface FieldFacts {
    visible: boolean;
    reach: Reach;
}

// The entry-independent facts about one form, looked up once per form: the
// hit-test behind `reach` forces a layout
export class FormFacts {
    private facts = new Map<MatchedField, FieldFacts>();
    readonly deps: CandidateDeps;

    constructor(
        readonly passwordFields: MatchedField[],
        readonly otherFields: MatchedField[],
        readonly usernameIndex: number | undefined,
        deps: CandidateDeps
    ) {
        // Candidates for each entry ask again; answer from the same lookups
        this.deps = {
            isVisible: el => this.factsOfElement(el).visible,
            isCoveredBySite: el => deps.isCoveredBySite(el)
        };
        const look = (f: MatchedField) => {
            if (!f?.DOMelement) return;
            this.facts.set(f, {
                visible: deps.isVisible(f.DOMelement),
                reach: reachOf(f, deps)
            });
        };
        passwordFields.forEach(look);
        otherFields.forEach(look);
    }

    private factsOfElement(el: HTMLElement): FieldFacts {
        for (const [f, facts] of this.facts) if (f.DOMelement === el) return facts;
        return { visible: false, reach: "reachable" };
    }

    // Visible and nothing keeps the user from it
    usable(f: MatchedField): boolean {
        const facts = this.facts.get(f);
        return !!facts && facts.visible && facts.reach === "reachable";
    }

    // Visible and not in the way, though maybe read-only or disabled for now:
    // some sites lock their login fields until clicked, to keep browsers out
    private couldTakeLogin(f: MatchedField): boolean {
        const facts = this.facts.get(f);
        return !!facts && facts.visible && facts.reach !== "in the way";
    }

    get loginField(): FormFit["loginField"] {
        if (this.passwordFields.some(f => this.couldTakeLogin(f))) return "password";
        const guess = this.otherFields[this.usernameIndex];
        if (guess && guess.field?.type === "text" && this.couldTakeLogin(guess)) return "username";
        return null;
    }

    get looksLikeSignUp(): boolean {
        const usablePasswords = this.passwordFields.filter(f => this.couldTakeLogin(f));
        return (
            usablePasswords.length >= 2 ||
            usablePasswords.some(f =>
                f.field.locators[0]?.autocompleteValues?.includes("new-password")
            )
        );
    }
}

function describeField(f: MatchedField): string {
    const locator = f.field.locators[0];
    return locator?.labels?.[0] || locator?.name || locator?.id || "unnamed";
}

// How `entry` fits the form. Also marks the page fields whose id or name an
// entry stores (MatchedField.matchesEntry), for the field icons.
export function assessFit(entry: Entry, form: FormFacts): FormFit {
    const textFields = entry.fields.filter(f => f.type !== "password");
    const passwordFields = entry.fields.filter(f => f.type === "password");
    const otherCandidates = findCandidates(
        form.otherFields,
        textFields,
        form.usernameIndex,
        form.deps
    );
    const passwordCandidates = findCandidates(
        form.passwordFields,
        passwordFields,
        undefined,
        form.deps
    );

    const matchedEntryFields = new Set<Field>();
    const mark = (candidates: typeof otherCandidates, fields: MatchedField[], data: Field[]) => {
        for (const c of candidates) {
            if (c.facts.idMatches || c.facts.nameMatches) {
                fields[c.formFieldIndex].matchesEntry = true;
                matchedEntryFields.add(data[c.dataFieldIndex]);
            }
        }
    };
    mark(otherCandidates, form.otherFields, textFields);
    mark(passwordCandidates, form.passwordFields, passwordFields);

    const loginField = form.loginField;
    const fit: FormFit = { loginField, storedMatches: matchedEntryFields.size, blocker: null };

    if (!loginField) {
        fit.blocker = { code: "no-login-field" };
    } else if (form.looksLikeSignUp) {
        fit.blocker = { code: "sign-up-form" };
    } else {
        const taken = new Set(pairFields(otherCandidates).map(p => p.winner.formFieldIndex));
        const extra = form.otherFields.filter(
            (f, i) => f?.field?.type === "text" && form.usable(f) && !taken.has(i)
        );
        if (extra.length > MAX_EXTRA_FIELDS) {
            fit.blocker = { code: "extra-fields", fields: extra.map(describeField) };
        }
    }
    return fit;
}

const LOGIN_FIELD_RANK = [null, "username", "password"];

// Which of two forms to fill (positive when `a`): the first rule that differs
// decides. On a tie the caller keeps the one that comes first on the page.
//  1. has a password field, before a username field, before neither
//  2. more of the entry's stored field names match
export function compareForms(a: FormFit, b: FormFit): number {
    return (
        LOGIN_FIELD_RANK.indexOf(a.loginField) - LOGIN_FIELD_RANK.indexOf(b.loginField) ||
        a.storedMatches - b.storedMatches
    );
}

// The order entries are offered in for a form (negative when `a` comes first).
// The site's preferred entry is picked ahead of all of them (fillDecision.ts).
//  1. how exactly an entry URL matches the page, as KeePass reports it
//  2. more of the entry's stored field names match the form
// On a tie, KeePass's order stays.
export function compareEntries(a: Entry, b: Entry): number {
    return (
        (b.matchAccuracy ?? 0) - (a.matchAccuracy ?? 0) ||
        (b.formFit?.storedMatches ?? 0) - (a.formFit?.storedMatches ?? 0)
    );
}

export function describeBlocker(blocker: FitBlocker): string {
    switch (blocker.code) {
        case "no-login-field":
            return "the form has no visible password field, and no username field of a first login step, that can be filled";
        case "sign-up-form":
            return "the form looks like a sign-up or change-password form (a new-password field, or two password fields)";
        case "extra-fields":
            return `the form has ${blocker.fields.length} other text fields the entry has nothing for (${blocker.fields.join(", ")}); a login has at most ${MAX_EXTRA_FIELDS}`;
    }
}
