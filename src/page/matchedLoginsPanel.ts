import { PanelStub, PanelStubOptions } from "./PanelStub";
import { KeeLog } from "../common/Logger";

// Owns the in-page "matched logins" panel iframe (its PanelStub and the
// requestAnimationFrame loop that keeps it positioned). Extracted verbatim from
// FormFilling - behaviour unchanged.
export class MatchedLoginsPanel {
    private stub: PanelStub = null;
    private raf: number;

    constructor(private parentFrameId: number) {}

    // The PanelStub currently on screen, if any (kept for API parity - nothing
    // outside FormFilling actually reads it).
    public get stubInstance(): PanelStub {
        return this.stub;
    }

    public createInCenter(specificFrameId: number) {
        this.close();
        this.stub = new PanelStub(PanelStubOptions.MatchedLogins, null, specificFrameId);
        this.stub.createPanel();
    }

    public createNearNode(target: HTMLElement) {
        this.close();
        this.stub = new PanelStub(PanelStubOptions.MatchedLogins, target, this.parentFrameId);
        KeeLog.debug("Creating panel...");
        this.stub.createPanel();
        this.raf = requestAnimationFrame(() => this.updatePosition());
    }

    public close() {
        if (this.stub) this.stub.closePanel();
        this.stub = null;
        cancelAnimationFrame(this.raf);
    }

    private updatePosition() {
        this.stub.updateBoundingClientRect();
        this.raf = requestAnimationFrame(() => this.updatePosition());
    }
}
