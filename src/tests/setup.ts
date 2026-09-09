// Minimal in-memory WebExtension API surface for unit tests.
//
// The real `chrome` global does not exist under vitest, and several modules
// (ConfigManager, and anything in background/) touch chrome APIs as soon as
// they are imported. This stub is deliberately small but complete enough to
// let those modules load and run; extend it as more code gains coverage.
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

const event = () => ({
    addListener: vi.fn(),
    removeListener: vi.fn(),
    hasListener: vi.fn(() => false)
});

const chromeStub = {
    runtime: {
        id: "kee-test",
        lastError: null as { message: string } | null,
        getManifest: () => ({ version: "0.0.0-test" }),
        getURL: (path: string) =>
            "chrome-extension://kee-test/" + String(path).replace(/^\//, ""),
        connect: vi.fn(() => ({
            name: "",
            postMessage: vi.fn(),
            disconnect: vi.fn(),
            onMessage: event(),
            onDisconnect: event()
        })),
        sendMessage: vi.fn(),
        onMessage: event(),
        onConnect: event(),
        onInstalled: event(),
        onStartup: event(),
        reload: vi.fn()
    },
    storage: {
        local: storageArea,
        sync: storageArea,
        onChanged: event()
    },
    i18n: { getMessage: (key: string) => key },
    action: {
        setIcon: vi.fn(),
        setBadgeText: vi.fn(),
        setBadgeBackgroundColor: vi.fn(),
        setTitle: vi.fn(),
        enable: vi.fn(),
        disable: vi.fn()
    },
    commands: { onCommand: event() },
    contextMenus: {
        create: vi.fn(),
        remove: vi.fn(),
        removeAll: vi.fn(),
        onClicked: event()
    },
    notifications: {
        create: vi.fn(),
        clear: vi.fn(),
        onButtonClicked: event(),
        onClicked: event()
    },
    tabs: {
        query: vi.fn(async () => []),
        create: vi.fn(async () => ({})),
        update: vi.fn(async () => ({})),
        remove: vi.fn(async () => undefined),
        sendMessage: vi.fn(),
        onActivated: event(),
        onUpdated: event(),
        onRemoved: event()
    },
    windows: {
        update: vi.fn(async () => ({})),
        onFocusChanged: event(),
        onRemoved: event()
    },
    webNavigation: {
        onCommitted: event(),
        onCompleted: event(),
        onBeforeNavigate: event(),
        onHistoryStateUpdated: event()
    },
    webRequest: { onAuthRequired: event() },
    idle: {
        setDetectionInterval: vi.fn(),
        onStateChanged: event()
    },
    alarms: {
        create: vi.fn(),
        clear: vi.fn(async () => true),
        onAlarm: event()
    },
    privacy: {
        services: {
            passwordSavingEnabled: { set: vi.fn(async () => undefined) }
        }
    }
};

// Reset the in-memory storage between tests so each starts from a clean slate.
beforeEach(() => {
    for (const k of Object.keys(store)) delete store[k];
    chromeStub.runtime.lastError = null;
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).chrome = chromeStub;
