import { FormUtils } from "./formsUtils";
import { Action } from "../common/Action";
import { type AddonMessage } from "../common/AddonMessage";
import { MatchedField } from "./MatchedField";
import { Entry } from "../common/model/Entry";

export type IconSide = "left" | "right";

const ICON_SIZE = 16;
const ICON_INSET = 4;
// Room made for the icon in front of the field's text when it sits on the left
const TEXT_OFFSET = ICON_SIZE + ICON_INSET;
// Fallback re-check for layout shifts no event tells us about (e.g. a banner
// inserted above the form)
const FALLBACK_INTERVAL_MS = 500;

type SavedStyle = { value: string; priority: string };

// One overlay icon attached to one input
class FieldIcon {
    host: HTMLDivElement;
    side: IconSide = null;
    lastRect = "";
    lastSize = "";
    savedStyles: Map<string, SavedStyle> = new Map();

    constructor(public element: HTMLInputElement) {}
}

// Shows the Kee icon over matched login fields. The icon is a separate element
// (closed shadow root, max z-index) rather than a background image on the input
// so site elements layered over the input (eye toggles, wrappers, other password
// managers) can't hide it. It prefers the left edge of the field and falls back
// to the right edge when the site already has something on the left.
export class KeeFieldIcon {
    constructor(
        private myPort: chrome.runtime.Port,
        private parentFrameId: number,
        private formUtils: FormUtils,
        private createMatchedLoginsPanelNearNode: (e: HTMLElement, side: IconSide) => void
    ) {}

    private icons: FieldIcon[] = [];
    private passwordFields: MatchedField[];
    private otherFields: MatchedField[];
    private raf: number = null;
    private fallbackTimer: number = null;
    private resizeObserver: ResizeObserver = null;
    private readonly scheduleUpdate = () => {
        if (this.raf !== null) return;
        this.raf = requestAnimationFrame(() => {
            this.raf = null;
            this.updatePositions();
        });
    };
    // Bumped on every add/remove so a slow labelled-icon render can't attach stale icons
    private generation = 0;

    public removeKeeIconFromAllFields() {
        this.generation++;
        for (const icon of this.icons) {
            icon.host.remove();
            this.restoreStyles(icon);
        }
        this.icons = [];
        this.passwordFields = null;
        this.otherFields = null;
        this.stopTracking();
    }

    public addKeeIconToFields(
        passwordFields: MatchedField[],
        otherFields: MatchedField[],
        entries: Entry[]
    ) {
        this.removeKeeIconFromAllFields();
        this.passwordFields = passwordFields;
        this.otherFields = otherFields;

        if (entries.length > 1) {
            this.getLabelledIcon(entries.length.toString());
        } else {
            this.afterImageLoaded(this.KEEFOX_ICON_16);
        }
    }

    private skipField(field: MatchedField) {
        if (
            !this.formUtils.isATextFormFieldType(field.field.type) &&
            field.field.type != "password"
        ) {
            return true;
        }
        if (
            !field.DOMelement ||
            field.DOMelement instanceof HTMLSelectElement ||
            !field.DOMelement.isConnected
        ) {
            return true;
        }
        if (field.DOMelement.maxLength > 0 && field.DOMelement.maxLength <= 3) return true;
        if (field.DOMelement.offsetWidth < 50) return true;
        return false;
    }

    private addIcon(field: MatchedField, image: string) {
        const icon = new FieldIcon(field.DOMelement as HTMLInputElement);

        const host = document.createElement("div");
        const shadow = host.attachShadow({ mode: "closed" });
        const style = document.createElement("style");
        style.textContent = `:host(div) {
            all: initial !important;
            display: none !important;
            position: absolute !important;
            z-index: 2147483647 !important;
            width: ${ICON_SIZE}px !important;
            height: ${ICON_SIZE}px !important;
            cursor: pointer !important;
            pointer-events: auto !important;
        }
        :host(div.visible) {
            display: block !important;
        }
        img {
            display: block;
            width: ${ICON_SIZE}px;
            height: ${ICON_SIZE}px;
        }`;
        shadow.appendChild(style);
        const img = document.createElement("img");
        img.src = image;
        img.alt = "";
        shadow.appendChild(img);
        host.title = $STR("matched_logins_label");

        // Keep focus (and the caret) in the input while clicking the icon
        host.addEventListener("mousedown", e => e.preventDefault());
        host.addEventListener("click", e => {
            e.preventDefault();
            e.stopPropagation();
            this.showMatchedLoginsPanel(icon);
        });

        icon.host = host;
        const bodyElements = document.getElementsByTagName("body");
        if (bodyElements && bodyElements.length > 0) {
            bodyElements[0].appendChild(host);
        } else {
            const framesetElements = document.getElementsByTagName("frameset");
            if (framesetElements && framesetElements.length > 0) {
                framesetElements[0].insertAdjacentElement("afterend", host);
            } else {
                return;
            }
        }

        this.icons.push(icon);
        this.updateIcon(icon);
    }

    private limitFields(fields: MatchedField[]) {
        const orderedFields = fields
            .filter(f => !this.skipField(f))
            .sort((a, b) => {
                if (a.highestScore === b.highestScore) return 0;
                return a.highestScore < b.highestScore ? 1 : -1;
            });
        return orderedFields.slice(0, 2);
    }

    private afterImageLoaded(image: string) {
        if (!this.passwordFields || !this.otherFields) return;
        // Put icons in only the top 2 matching password and text fields
        const fieldSet1 = this.limitFields(this.passwordFields);
        const fieldSet2 = this.limitFields(this.otherFields);
        for (const field of fieldSet1.concat(fieldSet2)) {
            this.addIcon(field, image);
        }
        if (this.icons.length > 0) this.startTracking();
    }

    // Follow the inputs as the page scrolls, resizes or re-lays itself out.
    // Event driven (plus a slow fallback timer) so an idle page costs nothing.
    private startTracking() {
        if (this.fallbackTimer !== null) return;
        // Capture so scrolling inside any scrollable container is seen too
        window.addEventListener("scroll", this.scheduleUpdate, { capture: true, passive: true });
        window.addEventListener("resize", this.scheduleUpdate, { passive: true });
        if (typeof ResizeObserver !== "undefined") {
            this.resizeObserver = new ResizeObserver(this.scheduleUpdate);
            if (document.body) this.resizeObserver.observe(document.body);
            for (const icon of this.icons) this.resizeObserver.observe(icon.element);
        }
        this.fallbackTimer = window.setInterval(
            () => this.updatePositions(),
            FALLBACK_INTERVAL_MS
        );
    }

    private stopTracking() {
        window.removeEventListener("scroll", this.scheduleUpdate, { capture: true });
        window.removeEventListener("resize", this.scheduleUpdate);
        this.resizeObserver?.disconnect();
        this.resizeObserver = null;
        if (this.fallbackTimer !== null) clearInterval(this.fallbackTimer);
        this.fallbackTimer = null;
        if (this.raf !== null) cancelAnimationFrame(this.raf);
        this.raf = null;
    }

    private updatePositions() {
        for (const icon of this.icons) this.updateIcon(icon);
    }

    private updateIcon(icon: FieldIcon) {
        const element = icon.element;
        const rect = element.isConnected ? element.getBoundingClientRect() : null;
        if (!rect || rect.width === 0 || rect.height === 0) {
            if (icon.lastRect !== "") {
                icon.host.classList.remove("visible");
                icon.lastRect = "";
            }
            return;
        }

        const rectKey = `${rect.left},${rect.top},${rect.width},${rect.height},${window.scrollX},${window.scrollY}`;
        if (rectKey === icon.lastRect) return;

        // Only re-check which side is free when the field changes size, not on every scroll
        const sizeKey = `${rect.width},${rect.height}`;
        if (sizeKey !== icon.lastSize || icon.side === null) {
            this.applySide(icon, this.chooseSide(icon, rect));
            icon.lastSize = sizeKey;
        }

        // Applying the side may have changed the field's padding, so measure again
        const r = element.getBoundingClientRect();
        icon.lastRect = `${r.left},${r.top},${r.width},${r.height},${window.scrollX},${window.scrollY}`;
        const x = icon.side === "left" ? r.left + ICON_INSET : r.right - ICON_INSET - ICON_SIZE;
        const y = r.top + (r.height - ICON_SIZE) / 2;
        icon.host.style.setProperty("left", x + window.scrollX + "px", "important");
        icon.host.style.setProperty("top", y + window.scrollY + "px", "important");
        icon.host.classList.add("visible");
    }

    // Prefer the left edge unless the site already shows something there
    private chooseSide(icon: FieldIcon, rect: DOMRect): IconSide {
        // Once we've made room on the left the spot is ours; keep it
        if (icon.side === "left") return "left";
        const y = rect.top + rect.height / 2;
        const leftX = rect.left + ICON_INSET + ICON_SIZE / 2;
        const rightX = rect.right - ICON_INSET - ICON_SIZE / 2;
        if (this.isSpotFree(icon, leftX, y) !== false) return "left";
        if (this.isSpotFree(icon, rightX, y)) return "right";
        return "left";
    }

    // true/false when we could tell, undefined when the spot can't be tested
    // (e.g. off-screen)
    private isSpotFree(icon: FieldIcon, x: number, y: number): boolean | undefined {
        const root = icon.element.getRootNode() as Document | ShadowRoot;
        if (typeof root.elementsFromPoint !== "function") return undefined;
        const ours = new Set<Element>(this.icons.map(i => i.host));
        const top = root.elementsFromPoint(x, y).find(e => !ours.has(e));
        if (!top) return undefined;
        return top === icon.element;
    }

    private applySide(icon: FieldIcon, side: IconSide) {
        if (icon.side === side) return;
        icon.side = side;
        this.restoreStyles(icon);
        if (side !== "left") return;

        // Move the field's text out from under the icon
        const style = window.getComputedStyle(icon.element);
        const paddingLeft = parseFloat(style.paddingLeft) || 0;
        if (paddingLeft >= TEXT_OFFSET + ICON_INSET) return;
        if (style.boxSizing === "border-box") {
            this.setStyle(icon, "padding-left", `${paddingLeft + TEXT_OFFSET}px`);
        } else {
            // Extra padding would make a content-box field wider and could break
            // the site's layout, so indent the text instead
            const indent = parseFloat(style.textIndent) || 0;
            this.setStyle(icon, "text-indent", `${indent + TEXT_OFFSET}px`);
        }
    }

    private setStyle(icon: FieldIcon, property: string, value: string) {
        const s = icon.element.style;
        if (!icon.savedStyles.has(property)) {
            icon.savedStyles.set(property, {
                value: s.getPropertyValue(property),
                priority: s.getPropertyPriority(property)
            });
        }
        s.setProperty(property, value, "important");
    }

    private restoreStyles(icon: FieldIcon) {
        for (const [property, saved] of icon.savedStyles) {
            icon.element.style.setProperty(property, saved.value, saved.priority);
        }
        icon.savedStyles.clear();
    }

    private showMatchedLoginsPanel(icon: FieldIcon) {
        if (this.parentFrameId !== 0) {
            this.myPort.postMessage({
                action: Action.ShowMatchedLoginsPanel
            } as AddonMessage);
        } else {
            this.createMatchedLoginsPanelNearNode(icon.element, icon.side ?? "left");
        }
    }

    private getLabelledIcon(text: string) {
        const generation = this.generation;
        const canvas = document.createElement("canvas");
        canvas.height = 16;
        canvas.width = 16;
        const img = document.createElement("img");
        img.addEventListener("load", () => {
            if (generation !== this.generation) return;
            const context = canvas.getContext("2d");
            context.drawImage(img, 0, 0);
            context.fillStyle = "white";
            context.fillRect(6, 8, 10, 8);
            context.fillStyle = "red";
            context.font = "8px Arial";
            context.fillText(text, 7, 15);
            this.afterImageLoaded(canvas.toDataURL());
        });
        img.src = this.KEEFOX_ICON_16;
    }

    readonly KEEFOX_ICON_16 =
        // eslint-disable-next-line max-len
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAABHNCSVQICAgIfAhkiAAAAAlwSFlzAAAA7AAAAOwBeShxvQAAABl0RVh0U29mdHdhcmUAd3d3Lmlua3NjYXBlLm9yZ5vuPBoAAAAOdEVYdFRpdGxlAEtlZSBsb2dvN59B9AAAABB0RVh0QXV0aG9yAEtlZSBWYXVsdGXwy5UAAAH8SURBVDiNhZDfS1NhGMc/z3vOEHea0lgXrkisvArWTUSlF9XFIKj/waugtP+hey/M5vpFN0Eg4UVB0WARSglC0IX2AwwtzdywppYsz862875dzLmDbfTcvd/n8/0+X16JX74Sxgt9AHrYmYhVfTbZ88Z6/SeWVEC/szF1brGvVDT2JRqzVLLUCTl28Xrbtq8LwL76JtU1axLhLTm/2A/A1JFp5txOM5RPSCBgM2ypLrWQSXkID+tqd8jljLMpjvgMRFcY2P+NsPI57WxId8gN+HmwkEl5NoBUuWUsrgIqZnu7xLXol6CBmF1mudIOUDU2aQAFsPoq/RkjGYB5L4KnFXvH04p5zwHAwNP8i/TybgAAYkYBitpieL0XP2D2geH1XorarqG6xgIEP0XiycH3wHGAU+0b3D44h6sthvIJZt3OOvYulx07WTcFuxojjeSlSq3u13KYT6VIAwowewOwttoeIRSC2sx2lIqpY5KPdhx43DLg+8yIK3A/qJ111gmJrtmNvvNx4ka5ZQCA0pIGKho0QET5AAYoVUXf+4ffK6y8HMsBEyVtuQC/dQgfMRjG17J3f/w3AEArc7Oo7fD4r0OMFI6ijShRarQZK81EgHhycBro23lO5rLpC824pg0AxEjjotD0OoDdarFaiT053Lb2VhB/uePn81bcX+xXu7resl9RAAAAAElFTkSuQmCC";
}
