// Test harness for the content-script form matching / filling pipeline.
//
// Instantiates a real FormFilling with real FormUtils against a jsdom document,
// stubbing only what would otherwise reach the network or the browser chrome:
// the KeePassRPC search (matchFinder), the messaging port, form-save handlers,
// the field icon, and element visibility (jsdom has no layout so every element
// would otherwise be "invisible").
import { vi } from "vitest";
import { FormFilling } from "../../page/formFilling";
import { FormUtils } from "../../page/formsUtils";
import { Entry } from "../../common/model/Entry";
import { Field } from "../../common/model/Field";
import { configManager } from "../../common/ConfigManager";

export const TEST_DB = "test.kdbx";

type FieldSpec = {
    type: "text" | "password";
    value: string;
    id?: string;
    name?: string;
};

// Build a KeePassRPC-style Entry with the given fields.
export function makeEntry(fields: FieldSpec[], overrides: Partial<Entry> = {}): Entry {
    return new Entry({
        uuid: overrides.uuid ?? "entry-1",
        title: overrides.title ?? "Test entry",
        URLs: overrides.URLs ?? ["https://localhost/"],
        matchAccuracy: overrides.matchAccuracy ?? 40,
        database: { fileName: TEST_DB } as Entry["database"],
        fields: fields.map(
            f =>
                new Field({
                    type: f.type,
                    value: f.value,
                    locators: [
                        {
                            id: f.id ?? "",
                            name: f.name ?? "",
                            type: f.type === "password" ? "password" : "text"
                        }
                    ]
                })
        ),
        ...overrides
    });
}

export type Harness = {
    formFilling: FormFilling;
    formUtils: FormUtils;
    port: { postMessage: ReturnType<typeof vi.fn> };
    matchFinder: ReturnType<typeof vi.fn>;
    // Run the light-DOM form scan.
    scan(): void;
    // Simulate KeePassRPC returning `entries` for the scan.
    deliverEntries(entries: Entry[]): void;
    // Convenience: scan + deliver in one call.
    run(entries: Entry[]): void;
    // Internal matchResult after a scan.
    matchResult(): any;
    // Current value of an input by id or name.
    fieldValue(idOrName: string): string | undefined;
};

// jsdom under vitest rejects `new UIEvent("input", { view: window })` across the
// module-isolation boundary ("view is not of type Window"). The content script
// dispatches such events after filling a field; for tests a plain Event is
// equivalent (nothing reads event.view).
class LenientUIEvent extends Event {
    constructor(type: string, init: EventInit = {}) {
        super(type, init);
    }
}

export function createHarness(bodyHtml: string): Harness {
    (globalThis as { UIEvent: unknown }).UIEvent = LenientUIEvent;
    document.body.innerHTML = bodyHtml;
    configManager.resetToDefault();

    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const port = { postMessage: vi.fn() };
    const matchFinder = vi.fn();
    const formSaving = {
        addSubmitHandler: vi.fn(),
        removeAllSubmitHandlers: vi.fn(),
        updateMatchResult: vi.fn()
    };
    const store = {
        state: {
            KeePassDatabases: [{ fileName: TEST_DB, sessionFeatures: [] as string[] }]
        }
    };

    const formUtils = new FormUtils(logger as never);
    // jsdom does no layout, so treat everything as visible unless a test opts out
    // with style="display:none" / hidden (which we honour here explicitly).
    formUtils.isDOMElementVisible = (el: HTMLElement) => {
        if (!el) return false;
        if (el.hasAttribute?.("hidden")) return false;
        return (el.style?.display || "").toLowerCase() !== "none";
    };

    const formFilling = new FormFilling(
        store as never,
        port as never,
        0,
        formUtils,
        formSaving as never,
        logger as never,
        configManager.current,
        matchFinder as never
    );
    // The field icon touches computed styles / canvas - irrelevant to matching.
    (formFilling as unknown as { keeFieldIcon: unknown }).keeFieldIcon = {
        addKeeIconToFields: vi.fn(),
        removeKeeIconFromAllFields: vi.fn()
    };

    const scan = () => formFilling.findMatchesInThisFrame();
    const deliverEntries = (entries: Entry[]) =>
        formFilling.findLoginsResultHandler(entries);

    return {
        formFilling,
        formUtils,
        port,
        matchFinder,
        scan,
        deliverEntries,
        run: (entries: Entry[]) => {
            scan();
            deliverEntries(entries);
        },
        matchResult: () =>
            (formFilling as unknown as { matchResult: unknown }).matchResult,
        fieldValue: (idOrName: string) => {
            const el =
                document.getElementById(idOrName) ||
                document.querySelector<HTMLInputElement>(`[name="${idOrName}"]`) ||
                deepFindInput(document, idOrName);
            return el ? (el as HTMLInputElement).value : undefined;
        }
    };
}

// Look for an input by id/name including inside open shadow roots.
function deepFindInput(root: ParentNode, idOrName: string): HTMLInputElement | null {
    const direct = root.querySelector<HTMLInputElement>(
        `#${CSS.escape(idOrName)}, [name="${idOrName}"]`
    );
    if (direct) return direct;
    for (const el of Array.from(root.querySelectorAll("*"))) {
        const sr = (el as { shadowRoot?: ShadowRoot }).shadowRoot;
        if (sr) {
            const found = deepFindInput(sr, idOrName);
            if (found) return found;
        }
    }
    return null;
}
