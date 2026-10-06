import { describe, expect, it } from "vitest";
import { diag, diagReportToPlainText, parseDiagLine } from "../common/diagnosisReport";

describe("diagnosis report markup", () => {
    it("round-trips every line kind through parseDiagLine", () => {
        expect(parseDiagLine(diag.title("T"))).toEqual({ kind: "title", text: "T" });
        expect(parseDiagLine(diag.frame("F"))).toEqual({ kind: "frame", text: "F" });
        expect(parseDiagLine(diag.heading("H"))).toEqual({ kind: "heading", text: "H" });
        expect(parseDiagLine(diag.kv("Key", "a: b"))).toEqual({
            kind: "kv",
            key: "Key",
            text: "a: b"
        });
        expect(parseDiagLine(diag.ok("o")).kind).toBe("ok");
        expect(parseDiagLine(diag.warn("w")).kind).toBe("warn");
        expect(parseDiagLine(diag.error("e")).kind).toBe("error");
        expect(parseDiagLine(diag.info("i")).kind).toBe("info");
        expect(parseDiagLine(diag.bullet("b")).kind).toBe("bullet");
        expect(parseDiagLine(diag.code("<form>")).kind).toBe("code");
        expect(parseDiagLine("plain")).toEqual({ kind: "text", text: "plain" });
    });

    it("renders readable plain text for copying", () => {
        const text = diagReportToPlainText([
            diag.title("Fill diagnosis"),
            diag.heading("Entry"),
            diag.kv("Title", "x"),
            diag.error("broken"),
            diag.bullet("reason")
        ]);
        expect(text).toBe(
            [
                "FILL DIAGNOSIS",
                "",
                "Entry",
                "-----",
                "Title: x",
                "[PROBLEM] broken",
                "  * reason"
            ].join("\n")
        );
    });
});
