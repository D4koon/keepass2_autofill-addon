import { PanelStub, PanelStubOptions } from "./PanelStub";

//const panelOptions = PanelStubOptions.GeneratePasswordLegacy;
const panelOptions = PanelStubOptions.GeneratePassword;

export class PasswordGenerator {
    public generatePasswordPanelStub: PanelStub;

    constructor(private parentFrameId: number) {}

    public createGeneratePasswordPanel() {
        this.closeGeneratePasswordPanel();
        this.generatePasswordPanelStub = new PanelStub(panelOptions, null, this.parentFrameId);
        this.generatePasswordPanelStub.createPanel();
    }

    // The panel keeps itself next to the field
    public createGeneratePasswordPanelNearNode(target: HTMLElement) {
        this.closeGeneratePasswordPanel();
        this.generatePasswordPanelStub = new PanelStub(panelOptions, target, this.parentFrameId);
        this.generatePasswordPanelStub.createPanel();
    }

    public closeGeneratePasswordPanel() {
        if (this.generatePasswordPanelStub) this.generatePasswordPanelStub.closePanel();
        this.generatePasswordPanelStub = null;
    }
}
