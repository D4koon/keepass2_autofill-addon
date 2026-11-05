import { configManager } from "../common/ConfigManager";
import { type IconSide } from "./keeFieldIcon";
import { showInTopLayer, topLayerAncestor } from "./topLayer";

export class PanelStubOptions {
    id: string;
    height: number;
    width: number;
    name: string;
    autoCloseTime: number;
    legacy: boolean;

    public static MatchedLogins: PanelStubOptions = {
        id: "KeeAddonPanelMatchedLogins",
        height: 300,
        width: 400,
        name: "matchedLoginsLegacy",
        autoCloseTime: 0,
        legacy: true
    };

    public static GeneratePasswordLegacy: PanelStubOptions = {
        id: "KeeAddonPanelGeneratePassword",
        height: 300,
        width: 400,
        name: "generatePasswordLegacy",
        autoCloseTime: 0,
        legacy: true
    };

    public static GeneratePassword: PanelStubOptions = {
        id: "KeeAddonPanelGeneratePassword",
        height: 500,
        width: 450,
        name: "generatePassword",
        autoCloseTime: 0,
        legacy: false
    };
}

export class PanelStub {
    // Remove any panel still on the page from before we (re)connected to the
    // background: one an earlier copy of the content script opened, or one whose
    // connection died with the background. Its contents can't be trusted anyway.
    public static removeLeftovers() {
        const ids = new Set(
            [
                PanelStubOptions.MatchedLogins,
                PanelStubOptions.GeneratePassword,
                PanelStubOptions.GeneratePasswordLegacy
            ].map(o => o.id)
        );
        for (const id of ids) document.getElementById(id)?.remove();
    }

    private target: HTMLElement;
    private container: HTMLElement;
    private targetRelativeRect: ClientRect;
    private options: PanelStubOptions;
    private parentFrameId: number;
    private elementToRefocus: Element;
    private anchorSide: IconSide;
    // Ends our listener on the modal dialog or popover the panel is shown in
    private layerListener: AbortController;

    constructor(
        options: PanelStubOptions,
        target: HTMLElement,
        parentFrameId: number,
        anchorSide: IconSide = "right"
    ) {
        this.target = target;
        this.options = options;
        this.parentFrameId = parentFrameId;
        this.anchorSide = anchorSide;
    }

    public createPanel() {
        if (this.options.name == "generatePassword") {
            this.elementToRefocus = document.activeElement;
        }
        this.container = document.createElement("div");
        const shadow = this.container.attachShadow({ mode: "closed" });
        this.container.id = this.options.id;
        const style = document.createElement("style");
        // The rest undoes the browser's popover styles (inset: 0 with margin:
        // auto centres it), for when the panel is shown as one; see topLayer.ts
        style.textContent = `:host(div) {
            display: block !important;
            position: absolute !important;
            z-index: 2147483647 !important;
            right: auto !important;
            bottom: auto !important;
            margin: 0 !important;
            border: none !important;
            padding: 0 !important;
            overflow: visible !important;
            background: transparent !important;
        }`;
        shadow.appendChild(style);

        if (this.target) {
            this.targetRelativeRect = this.target.getBoundingClientRect();
            this.positionPanel();
        } else {
            this.container.style.setProperty("width", this.options.width + "px", "important");
            this.container.style.setProperty("height", this.options.height + "px", "important");
            this.container.style.setProperty(
                "top",
                (window.innerHeight - this.options.height) / 2 + window.scrollY + "px",
                "important"
            );
            this.container.style.setProperty(
                "left",
                (window.innerWidth - this.options.width) / 2 + window.scrollX + "px",
                "important"
            );
        }

        const iframe = document.createElement("iframe");
        iframe.setAttribute("sandbox", "allow-scripts allow-same-origin");
        iframe.setAttribute("allow", "");
        iframe.style.setProperty("width", "100%", "important");
        iframe.style.setProperty("height", "100%", "important");
        iframe.style.setProperty("visibility", "visible", "important");
        iframe.style.setProperty("display", "block", "important");
        iframe.style.setProperty("position", "relative", "important");
        iframe.style.setProperty(
            "background-color",
            configManager.activeTheme === "dark" ? "#1e1e1e" : "#ffffff",
            "important"
        );
        iframe.setAttribute("scrolling", "no");
        if (this.options.legacy) {
            iframe.style.setProperty("border", "none", "important");
        } else {
            iframe.style.setProperty("border", "2px solid #1a466b", "important");
            iframe.style.setProperty("border-radius", "8px", "important");
        }

        shadow.appendChild(iframe);
        const template = chrome.runtime.getURL(
            `dist/panels/panels${this.options.legacy ? "Legacy" : ""}.html`
        );
        iframe.src = `${template}?parentFrameId=${this.parentFrameId}&autoCloseTime=${this.options.autoCloseTime}&panel=${this.options.name}&theme=${configManager.activeTheme}`;

        // A field in an open modal dialog or popover gets its panel in there too
        // (see topLayer.ts); without a field, wherever the focus is
        const layer = topLayerAncestor(this.target ?? document.activeElement);
        const bodyElements = document.getElementsByTagName("body");
        if (layer) {
            layer.appendChild(this.container);
            showInTopLayer(this.container);
            // Goes when the dialog or popover does
            this.layerListener = new AbortController();
            const close = () => this.closePanel();
            const { signal } = this.layerListener;
            layer.addEventListener("close", close, { signal });
            layer.addEventListener(
                "toggle",
                e => (e as ToggleEvent).newState === "closed" && close(),
                { signal }
            );
        } else if (bodyElements && bodyElements.length > 0) {
            bodyElements[0].appendChild(this.container);
        } else {
            const framesetElements = document.getElementsByTagName("frameset");
            if (framesetElements && framesetElements.length > 0) {
                framesetElements[0].insertAdjacentElement("afterend", this.container);
            }
        }
    }

    public updateBoundingClientRect() {
        const oldRect = this.targetRelativeRect;
        this.targetRelativeRect = this.target.getBoundingClientRect();

        if (
            oldRect.top != this.targetRelativeRect.top ||
            oldRect.bottom != this.targetRelativeRect.bottom ||
            oldRect.left != this.targetRelativeRect.left ||
            oldRect.right != this.targetRelativeRect.right
        ) {
            this.positionPanel();
        }
    }

    private positionPanel() {
        const preferredContainerHeight = this.options.height;
        let containerHeight = preferredContainerHeight;
        const containerWidth = this.options.width;
        let positionAbove = false;

        const targetTop = this.targetRelativeRect.top + window.scrollY;
        const targetBottom = this.targetRelativeRect.bottom + window.scrollY;
        const preferredArrowXCoord = this.targetRelativeRect.right - 12;

        const preferredBottom = this.targetRelativeRect.bottom + preferredContainerHeight;
        if (preferredBottom > window.innerHeight) {
            const preferredTop = this.targetRelativeRect.top - preferredContainerHeight;
            if (preferredTop >= 0) {
                positionAbove = true;
            } else {
                const overflowBottom = preferredBottom - window.innerHeight;
                const overflowTop = -preferredTop;
                if (overflowBottom > overflowTop) {
                    positionAbove = true;
                    containerHeight = preferredContainerHeight - overflowTop;
                } else {
                    containerHeight = preferredContainerHeight - overflowBottom;
                }
            }
        }

        // Move as far left as possible while keeping the Kee icon above the container and not
        // going beyond the left edge of the target. We assume the Kee icon is always visible because
        // the user has had to interact with the button initially. That assumption won't always hold
        // - e.g. in very narrow screens with keyboard activation or some later window or DOM adjustments but this should
        // be an edge case that users can work around until we have more time to extend support to those scenarios.
        const targetWidth = preferredArrowXCoord - this.targetRelativeRect.left;
        let relativeLeft: number;
        if (this.anchorSide === "left") {
            // Kee icon is at the left edge of the target, so line the panel up with that edge
            relativeLeft = Math.max(
                0,
                Math.min(this.targetRelativeRect.left, window.innerWidth - containerWidth)
            );
        } else if (targetWidth < containerWidth) {
            relativeLeft = Math.min(
                this.targetRelativeRect.left,
                window.innerWidth - containerWidth
            );
        } else {
            relativeLeft = preferredArrowXCoord - containerWidth;
        }

        const top = positionAbove ? targetTop - containerHeight : targetBottom;
        const left = relativeLeft + window.scrollX;
        this.container.style.setProperty("width", containerWidth + "px", "important");
        this.container.style.setProperty("height", containerHeight + "px", "important");
        this.container.style.setProperty("top", top + "px", "important");
        this.container.style.setProperty("left", left + "px", "important");
    }

    public closePanel() {
        this.layerListener?.abort();
        this.layerListener = null;
        // By id also catches one an earlier stub left; ours may be in a shadow
        // root, where the id lookup doesn't reach
        const panel = document.getElementById(this.options.id);
        if (panel) panel.parentNode.removeChild(panel);
        this.container?.remove();
        if (this.elementToRefocus) {
            try {
                (this.elementToRefocus as HTMLElement).focus();
            } catch {
                // Expected if activeElement was not actually an HTMLElement
            }
        }
    }
}
