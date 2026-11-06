import { MatchedField } from "./MatchedField";
import { Field } from "../common/model/Field";
import { isNotForUsername, isSwitchedOff } from "./fieldSignals";

// Which page field gets which entry field. Every pair whose types fit is a
// candidate. Two candidates are compared rule by rule (RULES below); the first
// rule that tells them apart decides. There are no points. The best candidate
// is filled, both of its fields drop out, and so on until no candidate is left.
// See docs/form-filling.adoc.

// Whether the user can get at the field: "locked" is read-only or disabled;
// "in the way" is covered by something else on the page, switched off by the
// site (inert/aria-hidden), or a search box or one-time code field
export type Reach = "reachable" | "in the way" | "locked";

export interface CandidateFacts {
    idMatches: boolean;
    nameMatches: boolean;
    visible: boolean;
    // A radio button whose value is the one the entry stores
    valueMatches: boolean;
    reach: Reach;
    isUsernameGuess: boolean;
    // Index of the page field among the fields of its kind, in page order
    position: number;
}

export interface Candidate {
    formFieldIndex: number;
    dataFieldIndex: number;
    facts: CandidateFacts;
}

interface Rule {
    // What the winner has, for the report: "beat #0 at rule 2: is visible"
    says: string;
    // Positive when `a` is better
    compare(a: CandidateFacts, b: CandidateFacts): number;
}

const yes = (v: boolean) => (v ? 1 : 0);

// Worst first, so a higher index is better
export const REACH_ORDER_BEST_LAST: readonly Reach[] = ["locked", "in the way", "reachable"];

export const RULES: Rule[] = [
    {
        says: "matches the id or name stored in the entry",
        compare: (a, b) => yes(a.idMatches || a.nameMatches) - yes(b.idMatches || b.nameMatches)
    },
    { says: "is visible", compare: (a, b) => yes(a.visible) - yes(b.visible) },
    {
        says: "matches both the stored id and name",
        compare: (a, b) => yes(a.idMatches && a.nameMatches) - yes(b.idMatches && b.nameMatches)
    },
    { says: "matches the stored id", compare: (a, b) => yes(a.idMatches) - yes(b.idMatches) },
    {
        says: "is the radio button with the stored value",
        compare: (a, b) => yes(a.valueMatches) - yes(b.valueMatches)
    },
    {
        says: "can be reached (not read-only or disabled, nothing in the way, not a search box or one-time code field)",
        compare: (a, b) => REACH_ORDER_BEST_LAST.indexOf(a.reach) - REACH_ORDER_BEST_LAST.indexOf(b.reach)
    },
    {
        says: "is the guessed username field",
        compare: (a, b) => yes(a.isUsernameGuess) - yes(b.isUsernameGuess)
    },
    { says: "comes first on the page", compare: (a, b) => b.position - a.position }
];

// Which candidate is better, and the rule that decided (index into RULES);
// better > 0 when `a` is
export function compareCandidates(
    a: CandidateFacts,
    b: CandidateFacts
): { better: number; rule: number } {
    for (let rule = 0; rule < RULES.length; rule++) {
        const better = RULES[rule].compare(a, b);
        if (better !== 0) return { better, rule };
    }
    return { better: 0, rule: -1 };
}

export interface CandidateDeps {
    isVisible(element: HTMLElement): boolean;
    // Whether something else on the page lies over the field (see fieldCover.ts)
    isCoveredBySite(element: HTMLElement): boolean;
}

function nonEmptyEqual(a: string | undefined | null, b: string | undefined | null) {
    return a != null && a !== "" && a === b;
}

// Every pair of page field and entry field whose types fit, with the facts the
// rules compare. Visibility and reach are looked up once per page field: the
// hit-test forces a layout.
export function findCandidates(
    formFields: MatchedField[],
    dataFields: Field[],
    usernameIndex: number | undefined,
    deps: CandidateDeps
): Candidate[] {
    const candidates: Candidate[] = [];
    formFields.forEach((formField, i) => {
        if (!formField?.field) return;
        let facts: Omit<CandidateFacts, "idMatches" | "nameMatches" | "valueMatches"> | null =
            null;
        dataFields.forEach((dataField, j) => {
            // Types that don't fit never pair up (e.g. a checkbox and a username)
            if (formField.field.type !== dataField.type) return;
            facts ??= {
                visible: deps.isVisible(formField.DOMelement),
                reach: reachOf(formField, deps),
                isUsernameGuess: i === usernameIndex,
                position: i
            };
            const page = formField.field.locators[0];
            const stored = dataField.locators[0];
            candidates.push({
                formFieldIndex: i,
                dataFieldIndex: j,
                facts: {
                    ...facts,
                    idMatches: nonEmptyEqual(page?.id, stored?.id),
                    nameMatches: nonEmptyEqual(page?.name, stored?.name),
                    valueMatches:
                        page?.type === "radio" &&
                        nonEmptyEqual(formField.field.value, dataField.value)
                }
            });
        });
    });
    return candidates;
}

export function reachOf(
    formField: MatchedField,
    deps: Pick<CandidateDeps, "isCoveredBySite">
): Reach {
    const el = formField.DOMelement as HTMLInputElement;
    if (!el) return "reachable";
    if (el.readOnly || el.disabled) return "locked";
    const labels = formField.field.locators?.[0]?.labels;
    if (isSwitchedOff(el) || isNotForUsername(el, labels) || deps.isCoveredBySite(el)) {
        return "in the way";
    }
    return "reachable";
}

export interface FieldPick {
    winner: Candidate;
    // The best other page field this entry field could have gone to, if any
    runnerUp?: Candidate;
    // The rule that put the winner ahead of the runner-up (index into RULES)
    rule?: number;
}

function best(candidates: Candidate[]): Candidate | undefined {
    return candidates.reduce<Candidate | undefined>(
        (top, c) => (!top || compareCandidates(c.facts, top.facts).better > 0 ? c : top),
        undefined
    );
}

// Pairs fields up: the best candidate first, then the best of what is left
export function pairFields(candidates: Candidate[]): FieldPick[] {
    const picks: FieldPick[] = [];
    let left = candidates;
    while (left.length > 0) {
        const winner = best(left);
        const runnerUp = best(
            left.filter(
                c =>
                    c.dataFieldIndex === winner.dataFieldIndex &&
                    c.formFieldIndex !== winner.formFieldIndex
            )
        );
        picks.push({
            winner,
            runnerUp,
            rule: runnerUp ? compareCandidates(winner.facts, runnerUp.facts).rule : undefined
        });
        left = left.filter(
            c =>
                c.dataFieldIndex !== winner.dataFieldIndex &&
                c.formFieldIndex !== winner.formFieldIndex
        );
    }
    return picks;
}
