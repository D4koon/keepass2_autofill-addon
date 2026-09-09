import { describe, expect, it } from "vitest";
import { SearcherAll } from "../common/SearcherAll";

type Summaryish = {
    title: string;
    usernameValue?: string;
    url?: string;
    uRLs?: string[];
    uuid: string;
};

const summary = (s: Summaryish) => ({
    usernameValue: "",
    url: s.uRLs?.[0] ?? "",
    uRLs: [],
    ...s
});

const group = (title: string, entries: Summaryish[], groups: unknown[] = []) => ({
    title,
    entrySummaries: entries.map(summary),
    groups
});

// A minimal KeeState the searcher is happy with.
const stateWith = (root: ReturnType<typeof group>) =>
    ({
        ActiveKeePassDatabaseIndex: 0,
        KeePassDatabases: [{ fileName: "db.kdbx", root }]
    }) as never;

const search = (root: ReturnType<typeof group>, query: string, filterDomains: string[] = []) => {
    const s = new SearcherAll(stateWith(root), { version: 1, searchAllDatabases: true });
    // No onComplete -> synchronous, returns the result array directly.
    return s.execute(query, null, filterDomains) as Array<Summaryish & { relevanceScore: number }>;
};

describe("SearcherAll.execute", () => {
    const root = group("Root", [
        { title: "My Bank", usernameValue: "alice", uuid: "bank", uRLs: ["https://bank.example/"] },
        { title: "Webmail", usernameValue: "bob", uuid: "mail", uRLs: ["https://mail.example/"] },
        {
            title: "Bank of Notes",
            usernameValue: "note",
            uuid: "notes",
            uRLs: ["https://notes.example/"]
        }
    ]);

    it("returns every entry matching a keyword", () => {
        const r = search(root, "bank");
        expect(r.map(e => e.uuid).sort()).toEqual(["bank", "notes"]);
    });

    it("orders results by descending relevance score", () => {
        const r = search(root, "bank");
        for (let i = 1; i < r.length; i++) {
            expect(r[i - 1].relevanceScore).toBeGreaterThanOrEqual(r[i].relevanceScore);
        }
    });

    it("returns nothing for a non-matching query", () => {
        expect(search(root, "nonexistent")).toEqual([]);
    });

    it("returns nothing for an empty query with no domain filter", () => {
        expect(search(root, "")).toEqual([]);
    });

    it("matches entries nested in sub-groups", () => {
        const nested = group("Root", [], [
            group("Finance", [
                { title: "Credit Union", usernameValue: "x", uuid: "cu", uRLs: ["https://cu.example/"] }
            ])
        ]);
        expect(search(nested, "credit").map(e => e.uuid)).toEqual(["cu"]);
    });

    it("gives entries under a matching group a relevance boost", () => {
        const nested = group("Root", [], [
            group("Bank", [
                { title: "Account", usernameValue: "x", uuid: "acct", uRLs: ["https://b.example/"] }
            ])
        ]);
        // "bank" matches the group title, not the entry title, yet the entry is returned.
        const r = search(nested, "bank");
        expect(r.map(e => e.uuid)).toEqual(["acct"]);
        expect(r[0].relevanceScore).toBeGreaterThan(0);
    });

    it("domain filter with empty query returns entries on that domain only", () => {
        const r = search(root, "", ["bank.example"]);
        expect(r.map(e => e.uuid)).toEqual(["bank"]);
    });

    it("honours maximumResults", () => {
        const many = group(
            "Root",
            Array.from({ length: 5 }, (_v, i) => ({
                title: `Bank ${i}`,
                usernameValue: "x",
                uuid: `b${i}`,
                uRLs: ["https://x.example/"]
            }))
        );
        const s = new SearcherAll(stateWith(many), {
            version: 1,
            searchAllDatabases: true,
            maximumResults: 2
        });
        expect((s.execute("bank", null, []) as unknown[]).length).toBe(2);
    });

    it("aborts (returns []) when the config is invalid", () => {
        const s = new SearcherAll(stateWith(root), {
            version: 1,
            weightTitles: -1 // must be positive
        });
        expect(s.execute("bank", null, [])).toEqual([]);
    });
});
