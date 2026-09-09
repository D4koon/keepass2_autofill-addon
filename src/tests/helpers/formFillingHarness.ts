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
import { Config } from "../../common/config";
import { configManager } from "../../common/ConfigManager";
import type { FindMatchesBehaviour } from "../../page/findMatchesBehaviour";

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

type MockFn = ReturnType<typeof vi.fn>;

export type SubmitObservation = { via: "form" | "click" | null; element?: Element };

export type Harness = {
    formFilling: FormFilling;
    formUtils: FormUtils;
    port: { postMessage: MockFn };
    matchFinder: MockFn;
    formSaving: { addSubmitHandler: MockFn; removeAllSubmitHandlers: MockFn; updateMatchResult: MockFn };
    keeFieldIcon: { addKeeIconToFields: MockFn; removeKeeIconFromAllFields: MockFn };
    logger: { debug: MockFn; info: MockFn; warn: MockFn; error: MockFn };
    // The live Config object FormFilling captured (mutate AFTER createHarness).
    cfg(): Config;
    // Run the light-DOM form scan (behaviour {}).
    scan(): void;
    // Run the scan with an explicit FindMatchesBehaviour (UUID / autofillOnSuccess / ...).
    scanWith(behaviour: FindMatchesBehaviour): void;
    // Simulate KeePassRPC returning `entries` for the scan.
    deliverEntries(entries: Entry[]): void;
    // Convenience: scan + deliver in one call.
    run(entries: Entry[]): void;
    // Manual fill: fillAndSubmit(false, formIndex, entryIndex).
    manualFill(entryIndex: number | string, formIndex?: number | null): void;
    // Mark an entry uuid as the preferred match for the current document origin.
    preferEntry(uuid: string): void;
    // Internal matchResult after a scan.
    matchResult(): any;
    // How the last form submission (if any) was performed.
    submitted(): SubmitObservation;
    // Entry lists announced to the popup via port.postMessage({ entries }).
    postedEntries(): Entry[][];
    // Current value of an input by id or name (incl. shadow DOM).
    fieldValue(idOrName: string): string | undefined;
};

export type HarnessOptions = {
    sessionFeatures?: string[];
};

export function createHarness(bodyHtml: string, opts: HarnessOptions = {}): Harness {
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
    const keeFieldIcon = {
        addKeeIconToFields: vi.fn(),
        removeKeeIconFromAllFields: vi.fn()
    };
    const store = {
        state: {
            KeePassDatabases: [
                { fileName: TEST_DB, sessionFeatures: opts.sessionFeatures ?? [] }
            ]
        }
    };

    // --- submit observation ------------------------------------------------
    // submitForm() either clicks a found button or calls form.submit(); jsdom
    // does not implement the latter. Capture both without a real navigation.
    let submitObs: SubmitObservation = { via: null };
    const origSubmit = HTMLFormElement.prototype.submit;
    HTMLFormElement.prototype.submit = function (this: HTMLFormElement) {
        submitObs = { via: "form", element: this };
    };
    const clickCapture = (e: Event) => {
        if (submitObs.via === null) submitObs = { via: "click", element: e.target as Element };
    };
    document.addEventListener("click", clickCapture, true);
    activeCleanups.push(() => {
        HTMLFormElement.prototype.submit = origSubmit;
        document.removeEventListener("click", clickCapture, true);
    });

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
    (formFilling as unknown as { keeFieldIcon: unknown }).keeFieldIcon = keeFieldIcon;

    return {
        formFilling,
        formUtils,
        port,
        matchFinder,
        formSaving,
        keeFieldIcon,
        logger,
        cfg: () => configManager.current,
        scan: () => formFilling.findMatchesInThisFrame(),
        scanWith: (behaviour: FindMatchesBehaviour) =>
            formFilling.findMatchesInThisFrame(behaviour),
        deliverEntries: (entries: Entry[]) => formFilling.findLoginsResultHandler(entries),
        run: (entries: Entry[]) => {
            formFilling.findMatchesInThisFrame();
            formFilling.findLoginsResultHandler(entries);
        },
        manualFill: (entryIndex: number | string, formIndex: number | null = null) =>
            (
                formFilling as unknown as {
                    fillAndSubmit(a: boolean, f: unknown, e: unknown): void;
                }
            ).fillAndSubmit(false, formIndex, entryIndex),
        preferEntry: (uuid: string) =>
            configManager.addSiteConfigParameters(
                { preferredEntryUuid: uuid } as never,
                new URL(document.URL),
                "Domain",
                "Exact",
                "Auto"
            ),
        matchResult: () =>
            (formFilling as unknown as { state: { current: unknown } }).state.current,
        submitted: () => submitObs,
        postedEntries: () =>
            port.postMessage.mock.calls
                .map(c => c[0])
                .filter((m: { entries?: Entry[] }) => m && m.entries)
                .map((m: { entries: Entry[] }) => m.entries),
        fieldValue: (idOrName: string) => {
            const el =
                document.getElementById(idOrName) ||
                document.querySelector<HTMLInputElement>(`[name="${idOrName}"]`) ||
                deepFindInput(document, idOrName);
            return el ? (el as HTMLInputElement).value : undefined;
        }
    };
}

// Harnesses patch global prototypes; each createHarness registers its undo here
// and the test file must call resetHarness() in afterEach.
const activeCleanups: Array<() => void> = [];
export function resetHarness() {
    while (activeCleanups.length) activeCleanups.pop()!();
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
