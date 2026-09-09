import { describe, expect, it, vi } from "vitest";
import { SRPc } from "../background/SRP";
import { utils } from "../common/utils";

// The SRP client's exact wire math is bespoke and tied to the KeePassRPC
// server, so these tests cover its observable behaviour and internal
// consistency rather than interoperability with a reference implementation.

const N = BigInt(
    "0xd4c7f8a2b32c11b8fba9581ec4ba4f1b04215642ef7355e37c0fc0443ef756ea2c6b8eeb755a1c723027663caa265ef785b8ff6a9b35227a52d86633dbdfca43"
);

describe("SRPc", () => {
    it("constructs with a public value A that is a non-zero residue mod N", () => {
        const c = new SRPc();
        expect(c.Astr).toMatch(/^[0-9A-F]+$/);
        const A = BigInt("0x" + c.Astr);
        expect(A % N).not.toBe(0n);
        expect(A < N).toBe(true);
        expect(c.authenticated).toBe(false);
    });

    it("generates a fresh A per instance", () => {
        expect(new SRPc().Astr).not.toBe(new SRPc().Astr);
    });

    it("setup() records the username", () => {
        const c = new SRPc();
        c.setup("alice");
        expect(c.I).toBe("alice");
    });

    it("receiveSalts() rejects when the password (p) has not been set", () => {
        const c = new SRPc();
        c.setup("alice");
        expect(() => c.receiveSalts("00", "01")).toThrow(/p not set/);
    });

    it("receiveSalts() computes M and M2 as SHA-256 hex digests, deterministically", async () => {
        const mk = async () => {
            const c = new SRPc();
            c.setup("alice");
            c.p = "sharedsecretkey";
            // Reuse one client's A for the second so the derived values line up.
            return c;
        };
        const c1 = await mk();
        // drive calculations with a fixed server ephemeral + salt
        await c1.receiveSalts("abcdef", "1a2b3c4d");
        expect(c1.M).toMatch(/^[0-9a-f]{64}$/);

        // same client re-run with identical inputs -> identical M
        const before = c1.M;
        await c1.receiveSalts("abcdef", "1a2b3c4d");
        expect(c1.M).toBe(before);
    });

    it("confirmAuthentication() accepts a matching M2 (case-insensitively) and rejects others", async () => {
        const c = new SRPc();
        c.setup("alice");
        c.p = "sharedsecretkey";
        await c.receiveSalts("abcdef", "1a2b3c4d");

        const errSpy = vi.spyOn(
            (await import("../common/Logger")).KeeLog,
            "error"
        ).mockImplementation(() => undefined);

        c.confirmAuthentication("not-the-right-proof");
        expect(c.authenticated).toBe(false);
        expect(errSpy).toHaveBeenCalled();

        // Pull the value the client expects and feed it back upper-cased.
        const expectedM2 = (c as unknown as { M2: string }).M2;
        c.confirmAuthentication(expectedM2.toUpperCase());
        expect(c.authenticated).toBe(true);

        errSpy.mockRestore();
    });

    it("key() returns null before authentication and a cached SHA-256 digest after", async () => {
        const c = new SRPc();
        c.setup("alice");
        c.p = "sharedsecretkey";
        await c.receiveSalts("abcdef", "1a2b3c4d");

        expect(await c.key()).toBeNull();

        (c as unknown as { authenticated: boolean }).authenticated = true;
        const k1 = await c.key();
        expect(k1).toMatch(/^[0-9a-f]{64}$/);
        expect(await c.key()).toBe(k1); // cached
    });

    it("its hash helper matches Web Crypto SHA-256", async () => {
        expect(await utils.hash("abc")).toBe(
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    });
});
