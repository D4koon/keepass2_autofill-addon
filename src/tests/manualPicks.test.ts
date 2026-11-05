import { describe, expect, it } from "vitest";
import { MANUAL_PICK_TTL_MS, ManualPicks } from "../background/ManualPicks";

const T0 = 1_000_000;
const STEP1 = "https://auth.gmx.net/login?step=1";

describe("ManualPicks", () => {
    it("hands the pick to the next page of the same site in the same tab", () => {
        const picks = new ManualPicks();
        picks.remember(7, "uuid-b", STEP1, T0);

        expect(picks.forPage(7, "https://login.gmx.net/password", T0 + 5000)).toEqual({
            uuid: "uuid-b",
            at: T0
        });
    });

    it("keeps it from another site", () => {
        const picks = new ManualPicks();
        picks.remember(7, "uuid-b", STEP1, T0);

        expect(picks.forPage(7, "https://evil.example.com/", T0 + 5000)).toBeUndefined();
        // and still has it for the right site
        expect(picks.forPage(7, "https://auth.gmx.net/", T0 + 5000)?.uuid).toBe("uuid-b");
    });

    it("keeps it from another tab", () => {
        const picks = new ManualPicks();
        picks.remember(7, "uuid-b", STEP1, T0);

        expect(picks.forPage(8, STEP1, T0)).toBeUndefined();
    });

    it("forgets it after a minute", () => {
        const picks = new ManualPicks();
        picks.remember(7, "uuid-b", STEP1, T0);

        expect(picks.forPage(7, STEP1, T0 + MANUAL_PICK_TTL_MS + 1)).toBeUndefined();
        expect(picks.forPage(7, STEP1, T0)).toBeUndefined();
    });

    it("forgets it once used or the tab is closed", () => {
        const picks = new ManualPicks();
        picks.remember(7, "uuid-b", STEP1, T0);

        picks.forget(7);

        expect(picks.forPage(7, STEP1, T0)).toBeUndefined();
    });

    it("replaces it with a newer pick", () => {
        const picks = new ManualPicks();
        picks.remember(7, "uuid-b", STEP1, T0);
        picks.remember(7, "uuid-c", STEP1, T0 + 1000);

        expect(picks.forPage(7, STEP1, T0 + 2000)?.uuid).toBe("uuid-c");
    });

    it("tells IP addresses apart", () => {
        const picks = new ManualPicks();
        picks.remember(7, "uuid-b", "http://192.168.1.1/login", T0);

        expect(picks.forPage(7, "http://192.168.1.2/login", T0)).toBeUndefined();
        expect(picks.forPage(7, "http://192.168.1.1/next", T0)?.uuid).toBe("uuid-b");
    });
});
