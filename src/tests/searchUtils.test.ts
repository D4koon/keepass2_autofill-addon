import { describe, expect, it } from "vitest";
import { calculateMatchScore, resolveConfig, tokenise } from "../common/SearchUtils";

const cfg = () => resolveConfig({ version: 1 });

describe("tokenise", () => {
    it("splits on whitespace and lower-cases", () => {
        expect(tokenise("Foo  BAR")).toEqual(["foo", "bar"]);
    });
    it("keeps quoted phrases together and strips the quotes", () => {
        expect(tokenise('"my bank" login')).toEqual(["my bank", "login"]);
        expect(tokenise("'single quoted'")).toEqual(["single quoted"]);
    });
    it("returns an empty array for an empty string", () => {
        expect(tokenise("")).toEqual([]);
    });
});

describe("resolveConfig", () => {
    it("fills every field with a default when given only a version", () => {
        const c = resolveConfig({ version: 1 });
        expect(c).toMatchObject({
            searchAllDatabases: true,
            searchTitles: true,
            searchUsernames: true,
            searchURLs: true,
            weightTitles: 2,
            weightUsernames: 1,
            weightURLs: 0.75,
            weightGroups: 0.25,
            maximumResults: 30
        });
    });
    it("keeps explicit false values (does not treat them as unset)", () => {
        expect(resolveConfig({ version: 1, searchUsernames: false }).searchUsernames).toBe(
            false
        );
    });
    it("accepts a null config", () => {
        expect(resolveConfig(null).maximumResults).toBe(30);
    });
});

describe("calculateMatchScore", () => {
    // Distinct, non-overlapping strings so a keyword targets exactly one field.
    const entry = (over: Record<string, unknown> = {}) => ({
        title: "Alpha",
        usernameValue: "bravo",
        url: "https://charlie.example/",
        uRLs: ["https://charlie.example/"],
        ...over
    });

    it("returns 0 when there are no keywords and no filter", () => {
        expect(calculateMatchScore(entry(), [], 0, cfg())).toBe(0);
    });

    it("weights a title hit above a username hit above a URL hit", () => {
        expect(calculateMatchScore(entry(), ["alpha"], 0, cfg())).toBe(2); // weightTitles
        expect(calculateMatchScore(entry(), ["bravo"], 0, cfg())).toBe(1); // weightUsernames
        expect(calculateMatchScore(entry(), ["charlie"], 0, cfg())).toBe(0.75); // weightURLs
    });

    it("sums the weights when one keyword hits several fields", () => {
        const e = entry({ title: "shared", usernameValue: "shared", uRLs: ["https://shared/"] });
        expect(calculateMatchScore(e, ["shared"], 0, cfg())).toBeCloseTo(2 + 1 + 0.75);
    });

    it("adds the group weight when a parent group already matched", () => {
        expect(calculateMatchScore(entry(), ["alpha"], 1, cfg())).toBe(2 + 0.25);
    });

    it("averages the per-keyword score across all keywords", () => {
        // "alpha" hits title (2), "zzz" hits nothing (0) -> (2 + 0) / 2
        expect(calculateMatchScore(entry(), ["alpha", "zzz"], 0, cfg())).toBe(1);
    });

    it("respects searchTitles = false", () => {
        const c = resolveConfig({ version: 1, searchTitles: false });
        expect(calculateMatchScore(entry(), ["alpha"], 0, c)).toBe(0);
    });

    it("scores a group by its title only", () => {
        expect(calculateMatchScore({ title: "Banking" }, ["bank"], 0, cfg())).toBe(1);
        expect(calculateMatchScore({ title: "Personal" }, ["bank"], 0, cfg())).toBe(0);
    });

    it("with a filter: excluded item scores 0, included item with no keywords scores 1", () => {
        const pass = () => true;
        const block = () => false;
        expect(calculateMatchScore(entry(), [], 0, cfg(), pass)).toBe(1);
        expect(calculateMatchScore(entry(), [], 0, cfg(), block)).toBe(0);
    });
});
