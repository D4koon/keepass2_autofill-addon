// Calls `update` whenever something we lay over the page (field icons, panels)
// may have to follow its field: on scroll (of the page or any scrollable box),
// resize, or a change in size of the page or the watched elements. Plus a slow
// fallback timer for layout shifts no event tells us about (e.g. a banner
// inserted above the form). Event driven, so an idle page costs next to
// nothing, and the timer pauses while the tab is hidden.
export const FALLBACK_INTERVAL_MS = 500;

export class PositionTracker {
    private raf: number = null;
    private fallbackTimer: number = null;
    private resizeObserver: ResizeObserver = null;
    private running = false;

    constructor(private readonly update: () => void) {}

    // At most one update per frame however many events come in
    private readonly schedule = () => {
        if (this.raf !== null) return;
        this.raf = requestAnimationFrame(() => {
            this.raf = null;
            this.update();
        });
    };

    private readonly onVisibilityChange = () => {
        if (document.hidden) {
            this.stopTimer();
        } else {
            // Whatever moved while we weren't looking
            this.schedule();
            this.startTimer();
        }
    };

    public get isRunning() {
        return this.running;
    }

    public start(elements: Element[]) {
        if (this.running) return;
        this.running = true;
        // Capture so scrolling inside any scrollable container is seen too
        window.addEventListener("scroll", this.schedule, { capture: true, passive: true });
        window.addEventListener("resize", this.schedule, { passive: true });
        document.addEventListener("visibilitychange", this.onVisibilityChange);
        if (typeof ResizeObserver !== "undefined") {
            this.resizeObserver = new ResizeObserver(this.schedule);
            if (document.body) this.resizeObserver.observe(document.body);
            for (const el of elements) this.resizeObserver.observe(el);
        }
        if (!document.hidden) this.startTimer();
    }

    public stop() {
        if (!this.running) return;
        this.running = false;
        window.removeEventListener("scroll", this.schedule, { capture: true });
        window.removeEventListener("resize", this.schedule);
        document.removeEventListener("visibilitychange", this.onVisibilityChange);
        this.resizeObserver?.disconnect();
        this.resizeObserver = null;
        this.stopTimer();
        if (this.raf !== null) cancelAnimationFrame(this.raf);
        this.raf = null;
    }

    private startTimer() {
        if (this.fallbackTimer !== null) return;
        this.fallbackTimer = window.setInterval(this.update, FALLBACK_INTERVAL_MS);
    }

    private stopTimer() {
        if (this.fallbackTimer !== null) clearInterval(this.fallbackTimer);
        this.fallbackTimer = null;
    }
}
