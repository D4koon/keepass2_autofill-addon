// @vitest-environment jsdom
//
// The content script's connection to the background (src/page/page.ts). The
// background can go away while a page stays open: restarted after a crash or
// standby, or the add-on reloaded or updated.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Action } from "../common/Action";

type Listener = (...args: unknown[]) => void;
type FakePort = {
    name: string;
    postMessage: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    onMessage: { addListener: (l: Listener) => void };
    onDisconnect: { addListener: (l: Listener) => void };
    // test helpers
    receive(msg: unknown): void;
    drop(): void;
};

let ports: FakePort[];

function fakePort(): FakePort {
    const onMessage: Listener[] = [];
    const onDisconnect: Listener[] = [];
    return {
        name: "page",
        postMessage: vi.fn(),
        disconnect: vi.fn(),
        onMessage: { addListener: l => onMessage.push(l) },
        onDisconnect: { addListener: l => onDisconnect.push(l) },
        receive: msg => onMessage.forEach(l => l(msg)),
        drop: () => onDisconnect.forEach(l => l())
    };
}

// Loads a fresh copy of the content script and lets it connect
async function loadPageScript() {
    vi.resetModules();
    await import("../page/page");
    // No pageshow in jsdom: the script starts up on its own after 1.5s
    await vi.advanceTimersByTimeAsync(1500);
    expect(ports).toHaveLength(1);
    // The background's first message on a new port
    ports[0].receive({ frameId: 0 });
}

const chromeRuntime = (globalThis as unknown as { chrome: { runtime: { id?: string; connect: unknown } } })
    .chrome.runtime;
const realConnect = chromeRuntime.connect;

beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    ports = [];
    chromeRuntime.connect = vi.fn(() => {
        const port = fakePort();
        ports.push(port);
        return port;
    });
    chromeRuntime.id = "kee-test";
    // jsdom has none; panels ask it for the colour theme
    window.matchMedia ??= ((query: string) =>
        ({
            matches: false,
            media: query,
            addEventListener() {},
            removeEventListener() {}
        }) as unknown as MediaQueryList) as typeof window.matchMedia;
});

afterEach(() => {
    // Leave the last copy idle so it doesn't reconnect into the next test
    chromeRuntime.id = undefined;
    ports.at(-1)?.drop();
    chromeRuntime.connect = realConnect;
    chromeRuntime.id = "kee-test";
    vi.useRealTimers();
});

describe("connection to the background", () => {
    it("reconnects when the background goes away", async () => {
        await loadPageScript();

        ports[0].drop();
        await vi.advanceTimersByTimeAsync(1000);

        expect(ports).toHaveLength(2);
    });

    it("waits longer each time the background drops it again straight away", async () => {
        await loadPageScript();

        ports[0].drop();
        await vi.advanceTimersByTimeAsync(1000);
        ports[1].drop(); // before the background answered
        await vi.advanceTimersByTimeAsync(1999);
        expect(ports).toHaveLength(2);
        await vi.advanceTimersByTimeAsync(1);
        expect(ports).toHaveLength(3);
    });

    it("starts over with a short wait once the background has answered", async () => {
        await loadPageScript();
        ports[0].drop();
        await vi.advanceTimersByTimeAsync(1000);
        ports[1].receive({ frameId: 0 });

        ports[1].drop();
        await vi.advanceTimersByTimeAsync(1000);

        expect(ports).toHaveLength(3);
    });

    it("stops when the add-on itself is gone", async () => {
        await loadPageScript();

        chromeRuntime.id = undefined;
        ports[0].drop();
        await vi.advanceTimersByTimeAsync(120000);

        expect(ports).toHaveLength(1);
    });

    it("ignores a port it already let go of on pagehide", async () => {
        await loadPageScript();

        window.dispatchEvent(new Event("pagehide"));
        ports[0].drop();
        await vi.advanceTimersByTimeAsync(120000);

        expect(ports).toHaveLength(1);
    });

    it("closes its panels when the background goes away", async () => {
        await loadPageScript();
        ports[0].receive({ action: Action.GeneratePassword });
        expect(document.getElementById("KeeAddonPanelGeneratePassword")).not.toBeNull();

        ports[0].drop();

        expect(document.getElementById("KeeAddonPanelGeneratePassword")).toBeNull();
    });

    it("removes a panel left over from before it connected", async () => {
        // e.g. opened by an earlier copy of the content script
        const leftover = document.createElement("div");
        leftover.id = "KeeAddonPanelMatchedLogins";
        document.body.appendChild(leftover);

        await loadPageScript();

        expect(leftover.isConnected).toBe(false);
    });
});
