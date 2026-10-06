// Line markup for the fill diagnosis report. The report travels between page,
// background and popup as a plain string[]; each line carries a short prefix so
// the popup can render it as a structured card and "Copy" can turn it back into
// readable plain text.

export type DiagLineKind =
    | "title"
    | "frame"
    | "heading"
    | "kv"
    | "ok"
    | "warn"
    | "error"
    | "info"
    | "bullet"
    | "code"
    | "text";

export interface DiagLine {
    kind: DiagLineKind;
    text: string;
    key?: string;
}

const KV_SEPARATOR = "\t";

const prefixes: [DiagLineKind, string][] = [
    ["title", "# "],
    ["frame", "[frame] "],
    ["heading", "## "],
    ["ok", "[ok] "],
    ["warn", "[warn] "],
    ["error", "[error] "],
    ["info", "[info] "],
    ["bullet", "- "],
    ["code", "[code] "]
];

export const diag = {
    title: (text: string) => "# " + text,
    frame: (text: string) => "[frame] " + text,
    heading: (text: string) => "## " + text,
    kv: (key: string, value: string | number) => key + KV_SEPARATOR + value,
    ok: (text: string) => "[ok] " + text,
    warn: (text: string) => "[warn] " + text,
    error: (text: string) => "[error] " + text,
    info: (text: string) => "[info] " + text,
    bullet: (text: string) => "- " + text,
    code: (text: string) => "[code] " + text
};

export function parseDiagLine(line: string): DiagLine {
    for (const [kind, prefix] of prefixes) {
        if (line.startsWith(prefix)) return { kind, text: line.slice(prefix.length) };
    }
    const sep = line.indexOf(KV_SEPARATOR);
    if (sep > 0) {
        return { kind: "kv", key: line.slice(0, sep), text: line.slice(sep + 1) };
    }
    return { kind: "text", text: line };
}

// Human-readable plain text, e.g. for pasting into an issue or chat.
export function diagReportToPlainText(lines: string[]): string {
    const out: string[] = [];
    for (const line of lines) {
        const l = parseDiagLine(line);
        switch (l.kind) {
            case "title":
                out.push(l.text.toUpperCase());
                break;
            case "frame":
                if (out.length && out[out.length - 1] !== "") out.push("");
                out.push("=== " + l.text + " ===");
                break;
            case "heading":
                if (out.length && out[out.length - 1] !== "") out.push("");
                out.push(l.text, "-".repeat(l.text.length));
                break;
            case "kv":
                out.push(`${l.key}: ${l.text}`);
                break;
            case "ok":
                out.push("[OK] " + l.text);
                break;
            case "warn":
                out.push("[WARNING] " + l.text);
                break;
            case "error":
                out.push("[PROBLEM] " + l.text);
                break;
            case "info":
                out.push("Note: " + l.text);
                break;
            case "bullet":
                out.push("  * " + l.text);
                break;
            case "code":
                out.push("    " + l.text);
                break;
            default:
                out.push(l.text);
        }
    }
    return out.join("\n");
}
