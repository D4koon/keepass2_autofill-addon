import { describe, expect, it } from "vitest";
import { CandidateFacts, Reach, RULES, compareCandidates, pairFields, Candidate } from "../page/fieldRanking";

const facts = (f: Partial<CandidateFacts>): CandidateFacts => ({
    idMatches: false,
    nameMatches: false,
    visible: true,
    valueMatches: false,
    reach: "reachable",
    isUsernameGuess: false,
    position: 0,
    ...f
});

// The points the fill used before the rules, with the tie order that came on
// top of them: reach, then the username guess, then page order
const REACH_RANK: Reach[] = ["reachable", "in the way", "locked"];
function oldOrder(a: CandidateFacts, b: CandidateFacts): number {
    const points = (f: CandidateFacts) =>
        1 + (f.idMatches ? 50 : 0) + (f.nameMatches ? 40 : 0) + (f.visible ? 35 : 0) + (f.valueMatches ? 30 : 0);
    return (
        points(a) - points(b) ||
        REACH_RANK.indexOf(b.reach) - REACH_RANK.indexOf(a.reach) ||
        Number(a.isUsernameGuess) - Number(b.isUsernameGuess) ||
        b.position - a.position
    );
}

function allFacts(position: number): CandidateFacts[] {
    const out: CandidateFacts[] = [];
    for (let bits = 0; bits < 16; bits++) {
        for (const reach of REACH_RANK) {
            for (const isUsernameGuess of [false, true]) {
                out.push({
                    idMatches: !!(bits & 1),
                    nameMatches: !!(bits & 2),
                    visible: !!(bits & 4),
                    valueMatches: !!(bits & 8),
                    reach,
                    isUsernameGuess,
                    position
                });
            }
        }
    }
    return out;
}

describe("field rules", () => {
    it("pick the same field as the old points, except in the two documented cases", () => {
        const differences: string[] = [];
        let documented = 0;
        for (const a of allFacts(0)) {
            for (const b of allFacts(1)) {
                const oldWinner = oldOrder(a, b) > 0 ? a : b;
                const newWinner = compareCandidates(a, b).better > 0 ? a : b;
                if (oldWinner === newWinner) continue;
                const matched = (f: CandidateFacts) => f.idMatches || f.nameMatches;
                // 1. A visible id/name match now beats a hidden one with more matches
                const visibleMatchWins =
                    matched(newWinner) && newWinner.visible && matched(oldWinner) && !oldWinner.visible;
                // 2. A radio button's stored value counts below an id or name match
                const radioValueBelowMatch =
                    oldWinner.valueMatches && !newWinner.valueMatches && matched(newWinner);
                if (!visibleMatchWins && !radioValueBelowMatch) {
                    differences.push(JSON.stringify({ oldWinner, newWinner }));
                } else {
                    documented++;
                }
            }
        }
        expect(differences).toEqual([]);
        // The comparison does see the documented differences
        expect(documented).toBeGreaterThan(0);
    });

    it("let a visible name match beat a hidden field whose id and name both match", () => {
        const hidden = facts({ idMatches: true, nameMatches: true, visible: false });
        const shown = facts({ nameMatches: true, position: 1 });
        expect(compareCandidates(shown, hidden)).toEqual({ better: 1, rule: 1 });
    });

    it("say which rule decided", () => {
        const search = facts({ reach: "in the way" });
        const user = facts({ isUsernameGuess: true, position: 2 });
        const { better, rule } = compareCandidates(user, search);
        expect(better).toBeGreaterThan(0);
        expect(RULES[rule].says).toMatch(/^can be reached/);
    });

    it("pair each entry field with one page field, best pair first", () => {
        // Two page fields, two entry fields; page field 1 has entry field 0's stored name
        const c = (formFieldIndex: number, dataFieldIndex: number, f: Partial<CandidateFacts>): Candidate => ({
            formFieldIndex,
            dataFieldIndex,
            facts: facts({ position: formFieldIndex, ...f })
        });
        const picks = pairFields([
            c(0, 0, {}),
            c(0, 1, {}),
            c(1, 0, { nameMatches: true }),
            c(1, 1, {})
        ]);

        expect(picks.map(p => [p.winner.dataFieldIndex, p.winner.formFieldIndex])).toEqual([
            [0, 1],
            [1, 0]
        ]);
        expect(picks[0].runnerUp.formFieldIndex).toBe(0);
        expect(picks[0].rule).toBe(0);
        // Nothing else left for the second entry field
        expect(picks[1].runnerUp).toBeUndefined();
    });
});
