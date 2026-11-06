import { PanelStub, PanelStubOptions } from "./PanelStub";
import { KeeLog } from "../common/Logger";
import { type IconSide } from "./keeFieldIcon";

// Owns the in-page "matched logins" panel iframe (its PanelStub, which keeps
// itself next to its field).
export class MatchedLoginsPanel {
    private stub: PanelStub = null;

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

    public createNearNode(target: HTMLElement, side: IconSide = "right") {
        this.close();
        this.stub = new PanelStub(
            PanelStubOptions.MatchedLogins,
            target,
            this.parentFrameId,
            side
        );
        KeeLog.debug("Creating panel...");
        this.stub.createPanel();
    }

    public close() {
        if (this.stub) this.stub.closePanel();
        this.stub = null;
    }
}
