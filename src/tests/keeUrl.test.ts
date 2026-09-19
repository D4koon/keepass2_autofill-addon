import { describe, expect, it } from "vitest";
import { KeeURL } from "../common/KeeURL";

describe("KeeURL.fromString", () => {
    it("assumes https:// when no scheme is given", () => {
        const u = KeeURL.fromString("www.example.com/path");
        expect(u).not.toBeNull();
        expect(u.url.protocol).toBe("https:");
        expect(u.url.hostname).toBe("www.example.com");
    });

    it("keeps an explicit http:// / file:// scheme", () => {
        expect(KeeURL.fromString("http://example.com").url.protocol).toBe("http:");
        expect(KeeURL.fromString("file:///etc/hosts").url.protocol).toBe("file:");
    });

    it("derives the registrable domain via the public suffix list", () => {
        expect(KeeURL.fromString("https://a.b.example.com/x").domain).toBe("example.com");
        expect(KeeURL.fromString("https://example.com").domain).toBe("example.com");
    });

    it("recognises IPv4 hosts and does not treat them as domains", () => {
        const u = KeeURL.fromString("http://192.168.2.56:8123/");
        expect(u.isIPAddress).toBe(true);
        expect(u.domain).toBeNull();
        expect(u.domainOrIPAddress).toBe("192.168.2.56");
    });

    it("domainOrIPAddress falls back to the domain for normal hosts", () => {
        expect(KeeURL.fromString("https://www.example.com").domainOrIPAddress).toBe("example.com");
    });

    it("domainWithPort appends the port only when present", () => {
        expect(KeeURL.fromString("https://www.example.com").domainWithPort).toBe("example.com");
        expect(KeeURL.fromString("https://www.example.com:8443").domainWithPort).toBe("example.com:8443");
    });

    it("returns an empty domainWithPort when there is no domain (IP host)", () => {
        expect(KeeURL.fromString("http://10.0.0.1:9000/").domainWithPort).toBe("");
    });

    it("returns null for an unparseable URL", () => {
        expect(KeeURL.fromString("http://")).toBeNull();
    });
});
