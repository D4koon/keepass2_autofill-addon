// Minimal in-memory WebExtension API surface for unit tests.
//
// The real `chrome` global does not exist under vitest, and several core modules
// (ConfigManager in particular) touch chrome.storage as soon as they are
// imported. This stub is deliberately small - extend it as more of the codebase
// gains test coverage.
import { beforeEach, vi } from "vitest";

const store: Record<string, unknown> = {};

const storageArea = {
    get: vi.fn(
        async (keys?: string | string[] | Record<string, unknown> | null) => {
            if (keys === null || keys === undefined) return { ...store };
            if (typeof keys === "string") {
                return keys in store ? { [keys]: store[keys] } : {};
            }
            if (Array.isArray(keys)) {
                const out: Record<string, unknown> = {};
                for (const k of keys) if (k in store) out[k] = store[k];
                return out;
            }
            const out: Record<string, unknown> = { ...keys };
            for (const k of Object.keys(keys)) if (k in store) out[k] = store[k];
            return out;
        }
    ),
    set: vi.fn(async (items: Record<string, unknown>) => {
        Object.assign(store, items);
    }),
    remove: vi.fn(async (keys: string | string[]) => {
        for (const k of Array.isArray(keys) ? keys : [keys]) delete store[k];
    }),
    clear: vi.fn(async () => {
        for (const k of Object.keys(store)) delete store[k];
    })
};

const chromeStub = {
    runtime: {
        id: "kee-test",
        lastError: undefined,
        getManifest: () => ({ version: "0.0.0-test" }),
        getURL: (path: string) =>
            "chrome-extension://kee-test/" + String(path).replace(/^\//, "")
    },
    storage: {
        local: storageArea,
        sync: storageArea,
        onChanged: {
            addListener: vi.fn(),
            removeListener: vi.fn(),
            hasListener: vi.fn(() => false)
        }
    },
    i18n: {
        getMessage: (key: string) => key
    }
};

// Reset the in-memory store between tests so each starts from a clean slate.
beforeEach(() => {
    for (const k of Object.keys(store)) delete store[k];
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).chrome = chromeStub;
