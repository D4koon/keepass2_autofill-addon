// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FALLBACK_INTERVAL_MS, PositionTracker } from "../page/positionTracker";
import { PanelStub, PanelStubOptions } from "../page/PanelStub";

let hidden = false;

function setHidden(value: boolean) {
    hidden = value;
    document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
    vi.useFakeTimers();
    hidden = false;
    Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
    // Run animation-frame callbacks straight away
    vi.stubGlobal(
        "requestAnimationFrame",
        vi.fn((cb: FrameRequestCallback) => {
            cb(0);
            return 1;
        })
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    // jsdom has none; the panel asks it for the theme
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    document.body.innerHTML = "";
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    delete (document as { hidden?: boolean }).hidden;
});

describe("PositionTracker", () => {
    it("updates on scroll and on the fallback timer", () => {
        const update = vi.fn();
        const tracker = new PositionTracker(update);
        tracker.start([]);

        window.dispatchEvent(new Event("scroll"));
        expect(update).toHaveBeenCalledTimes(1);

        vi.advanceTimersByTime(FALLBACK_INTERVAL_MS);
        expect(update).toHaveBeenCalledTimes(2);
        tracker.stop();
    });

    it("pauses the timer while the tab is hidden and catches up when it's back", () => {
        const update = vi.fn();
        const tracker = new PositionTracker(update);
        tracker.start([]);

        setHidden(true);
        expect(vi.getTimerCount()).toBe(0);
        vi.advanceTimersByTime(FALLBACK_INTERVAL_MS * 10);
        expect(update).not.toHaveBeenCalled();

        setHidden(false);
        expect(update).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(FALLBACK_INTERVAL_MS);
        expect(update).toHaveBeenCalledTimes(2);
        tracker.stop();
    });

    it("starts without a timer in a hidden tab", () => {
        hidden = true;
        const tracker = new PositionTracker(vi.fn());
        tracker.start([]);

        expect(vi.getTimerCount()).toBe(0);
        tracker.stop();
    });

    it("stops listening and timing once stopped", () => {
        const update = vi.fn();
        const tracker = new PositionTracker(update);
        tracker.start([]);
        tracker.stop();

        window.dispatchEvent(new Event("scroll"));
        setHidden(true);
        setHidden(false);
        vi.advanceTimersByTime(FALLBACK_INTERVAL_MS * 4);

        expect(update).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });
});

describe("PanelStub next to a field", () => {
    function field() {
        const input = document.createElement("input");
        document.body.appendChild(input);
        let top = 50;
        input.getBoundingClientRect = () =>
            ({ left: 100, top, right: 300, bottom: top + 30, width: 200, height: 30 }) as DOMRect;
        return { input, moveTo: (t: number) => (top = t) };
    }

    const panel = () =>
        document.getElementById(PanelStubOptions.MatchedLogins.id) as HTMLElement;

    it("follows the field when the page scrolls, and not after it closed", () => {
        const { input, moveTo } = field();
        const stub = new PanelStub(PanelStubOptions.MatchedLogins, input, 0);
        stub.createPanel();
        expect(panel().style.top).toBe("80px");

        moveTo(10);
        window.dispatchEvent(new Event("scroll"));
        expect(panel().style.top).toBe("40px");

        stub.closePanel();
        expect(panel()).toBeNull();
        expect(vi.getTimerCount()).toBe(0);
    });

    it("needs no tracking in the middle of the page", () => {
        const stub = new PanelStub(PanelStubOptions.MatchedLogins, null, 0);
        stub.createPanel();

        expect(vi.getTimerCount()).toBe(0);
        stub.closePanel();
    });
});
