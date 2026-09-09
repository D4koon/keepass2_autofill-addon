import { describe, expect, it } from "vitest";
import { KeeURL } from "../common/KeeURL";

describe("KeeURL.fromString", () => {
    it("assumes https:// when no scheme is given", () => {
        const u = KeeURL.fromString("www.kee.pm/path");
        expect(u).not.toBeNull();
        expect(u.url.protocol).toBe("https:");
        expect(u.url.hostname).toBe("www.kee.pm");
    });

    it("keeps an explicit http:// / file:// scheme", () => {
        expect(KeeURL.fromString("http://example.com").url.protocol).toBe("http:");
        expect(KeeURL.fromString("file:///etc/hosts").url.protocol).toBe("file:");
    });

    it("derives the registrable domain via the public suffix list", () => {
        expect(KeeURL.fromString("https://a.b.kee.pm/x").domain).toBe("kee.pm");
        expect(KeeURL.fromString("https://kee.pm").domain).toBe("kee.pm");
    });

    it("recognises IPv4 hosts and does not treat them as domains", () => {
        const u = KeeURL.fromString("http://192.168.2.56:8123/");
        expect(u.isIPAddress).toBe(true);
        expect(u.domain).toBeNull();
        expect(u.domainOrIPAddress).toBe("192.168.2.56");
    });

    it("domainOrIPAddress falls back to the domain for normal hosts", () => {
        expect(KeeURL.fromString("https://www.kee.pm").domainOrIPAddress).toBe("kee.pm");
    });

    it("domainWithPort appends the port only when present", () => {
        expect(KeeURL.fromString("https://www.kee.pm").domainWithPort).toBe("kee.pm");
        expect(KeeURL.fromString("https://www.kee.pm:8443").domainWithPort).toBe("kee.pm:8443");
    });

    it("returns an empty domainWithPort when there is no domain (IP host)", () => {
        expect(KeeURL.fromString("http://10.0.0.1:9000/").domainWithPort).toBe("");
    });

    it("returns null for an unparseable URL", () => {
        expect(KeeURL.fromString("http://")).toBeNull();
    });
});
