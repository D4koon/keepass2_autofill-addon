import { FormUtils } from "./formsUtils";
import { Action } from "../common/Action";
import { type AddonMessage } from "../common/AddonMessage";
import { MatchedField } from "./MatchedField";
import { Entry } from "../common/model/Entry";
import { leaveTopLayer, showInTopLayer, topLayerAncestor } from "./topLayer";
import { PositionTracker } from "./positionTracker";
import { ICON_HOST_ATTR, fieldBox, fieldSurroundings, isIconHost, siteElementAt } from "./fieldCover";

export type IconSide = "left" | "right";

const ICON_SIZE = 16;
const ICON_INSET = 0;
// Where the field's text starts when the icon sits on the left: just past the
// icon plus a small gap. The site's own padding counts towards it.
const TEXT_START = ICON_INSET + ICON_SIZE + 4;
const LEFT_VAR = "--keelink-icon-left";
const TOP_VAR = "--keelink-icon-top";
// How often an icon is put back after the site removed it, before we accept
// the site wants it gone
const MAX_REATTACH = 3;

function pageRectKey(r: DOMRect): string {
    return `${r.left + window.scrollX},${r.top + window.scrollY},${r.width},${r.height}`;
}

type SavedStyle = { element: HTMLElement; property: string; value: string; priority: string };

// Labels the site lays over the field itself, e.g. a floating label that sits
// where the text goes until the field is focused or filled (auth.gmx.net)
function overlaidLabels(box: HTMLElement, input: HTMLElement): HTMLElement[] {
    const labels = new Set<HTMLLabelElement>();
    for (const el of new Set([box, input])) {
        for (const label of Array.from((el as HTMLInputElement).labels ?? [])) labels.add(label);
        // A form-associated custom element has no .labels of its own
        if (!el.id) continue;
        const root = el.getRootNode() as Document | ShadowRoot;
        for (const label of Array.from(root.querySelectorAll("label"))) {
            if (label.htmlFor === el.id) labels.add(label);
        }
    }
    // A label next to the field in the same wrapper, whatever its for= says
    // (auth.gmx.net has <label for="username"> on #input-username)
    for (const sibling of Array.from(box.parentElement?.children ?? [])) {
        if (sibling instanceof HTMLLabelElement) labels.add(sibling);
    }
    const field = box.getBoundingClientRect();
    return Array.from(labels).filter(label => {
        const position = window.getComputedStyle(label).position;
        if (position !== "absolute" && position !== "fixed") return false;
        const r = label.getBoundingClientRect();
        return (
            r.width > 0 &&
            r.left < field.right &&
            r.right > field.left &&
            r.top < field.bottom &&
            r.bottom > field.top
        );
    });
}

// One overlay icon attached to one input
class FieldIcon {
    host: HTMLDivElement;
    // What the icon is positioned on and makes room in; see fieldBox
    box: HTMLElement;
    side: IconSide = null;
    lastRect = "";
    lastSize = "";
    savedStyles: SavedStyle[] = [];
    reattached = 0;
    // The open modal dialog or popover the icon is shown in; see topLayer.ts
    layer: HTMLElement = null;

    constructor(public element: HTMLInputElement) {
        this.box = fieldBox(element);
    }
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
    // Follows the inputs as the page scrolls, resizes or re-lays itself out
    private tracker = new PositionTracker(() => this.updatePositions());
    // Bumped on every add/remove so a slow labelled-icon render can't attach stale icons
    private generation = 0;
    // The style attribute each field had right after we last changed it
    private ownStyles = new WeakMap<Element, string>();

    // Is this mutation just our own style change on a field? The page's mutation
    // observer must not rescan for it: a rescan redraws the icons, which changes
    // the style again, and the icons and field text flicker in a loop
    // So is anything on the icons themselves: adding or removing one, moving it
    // (its style) or showing it (its class).
    public isOwnMutation(mutation: MutationRecord): boolean {
        const target = mutation.target as Element;
        if (isIconHost(target)) return true;
        if (mutation.type === "childList") {
            const nodes = [...mutation.addedNodes, ...mutation.removedNodes];
            return nodes.length > 0 && nodes.every(isIconHost);
        }
        return (
            mutation.type === "attributes" &&
            mutation.attributeName === "style" &&
            this.ownStyles.get(target) === target.getAttribute("style")
        );
    }

    public removeKeeIconFromAllFields() {
        this.generation++;
        for (const icon of this.icons) {
            icon.host.remove();
            this.restoreStyles(icon);
        }
        this.icons = [];
        this.passwordFields = null;
        this.otherFields = null;
        this.tracker.stop();
    }

    public addKeeIconToFields(
        passwordFields: MatchedField[],
        otherFields: MatchedField[],
        entries: Entry[]
    ) {
        this.removeKeeIconFromAllFields();
        for (const leftover of Array.from(document.querySelectorAll(`[${ICON_HOST_ATTR}]`))) {
            leftover.remove();
        }
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
        host.setAttribute(ICON_HOST_ATTR, "");
        const shadow = host.attachShadow({ mode: "closed" });
        const style = document.createElement("style");
        // `all: initial !important` here beats the host's inline styles (important
        // shadow-tree rules win over the style attribute), so the position comes in
        // through custom properties, which `all` doesn't reset
        style.textContent = `:host(div) {
            all: initial !important;
            display: none !important;
            position: absolute !important;
            left: var(${LEFT_VAR}) !important;
            top: var(${TOP_VAR}) !important;
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
        if (!this.placeHost(icon, true)) return;

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
        if (this.icons.length > 0) this.tracker.start(this.icons.map(i => i.box));
    }

    private updatePositions() {
        for (const icon of this.icons) this.updateIcon(icon);
    }

    private attach(host: HTMLDivElement): boolean {
        const bodyElements = document.getElementsByTagName("body");
        if (bodyElements && bodyElements.length > 0) {
            bodyElements[0].appendChild(host);
            return true;
        }
        const framesetElements = document.getElementsByTagName("frameset");
        if (framesetElements && framesetElements.length > 0) {
            framesetElements[0].insertAdjacentElement("afterend", host);
            return true;
        }
        return false;
    }

    // Put the icon where it can be seen and clicked: in the open modal dialog or
    // popover the field is in, else in <body>. False if it can't be shown.
    private placeHost(icon: FieldIcon, initial = false): boolean {
        if (!icon.host.isConnected && !initial) {
            // Some sites clear out whatever they didn't render themselves
            if (icon.reattached >= MAX_REATTACH) return false;
            icon.reattached++;
        }
        const layer = topLayerAncestor(icon.box);
        if (layer) {
            if (icon.host.parentNode !== layer) {
                layer.appendChild(icon.host);
                icon.lastRect = "";
            }
            showInTopLayer(icon.host);
            icon.layer = layer;
            return true;
        }
        if (icon.layer || !icon.host.isConnected) {
            // The dialog or popover closed, or we're new or were removed
            leaveTopLayer(icon.host);
            icon.layer = null;
            if (!this.attach(icon.host)) return false;
            icon.lastRect = "";
        }
        return true;
    }

    private updateIcon(icon: FieldIcon) {
        if (!this.placeHost(icon)) return;

        const element = icon.box;
        const rect = element.isConnected ? element.getBoundingClientRect() : null;
        if (!rect || rect.width === 0 || rect.height === 0) {
            if (icon.lastRect !== "") {
                icon.host.classList.remove("visible");
                icon.lastRect = "";
            }
            return;
        }

        // Where the field is on the page: scrolling the page doesn't change that,
        // and so costs nothing; the icon scrolls along by itself
        if (pageRectKey(rect) !== icon.lastRect) this.position(icon, rect);

        // The icon sits above everything, so it would show through whatever the
        // site lays over the field: a menu, a dialog, a sticky header. It hides
        // while something like that is in the way, and on a field that can't be
        // filled anyway. Checked every time, as these change without the field
        // moving.
        const blocked = icon.element.disabled || this.isCoveredBySite(icon, rect);
        icon.host.classList.toggle("visible", !blocked);
    }

    private position(icon: FieldIcon, rect: DOMRect) {
        const element = icon.box;
        // Only re-check which side is free when the field changes size, not on every scroll
        const sizeKey = `${rect.width},${rect.height}`;
        if (sizeKey !== icon.lastSize || icon.side === null) {
            this.applySide(icon, this.chooseSide(icon, rect));
            icon.lastSize = sizeKey;
        }

        // Applying the side may have changed the field's padding, so measure again
        const r = element.getBoundingClientRect();
        icon.lastRect = pageRectKey(r);
        const x = icon.side === "left" ? r.left + ICON_INSET : r.right - ICON_INSET - ICON_SIZE;
        const y = r.top + (r.height - ICON_SIZE) / 2;
        const left = x + window.scrollX;
        const top = y + window.scrollY;
        this.place(icon, left, top);
        icon.host.classList.add("visible");

        // left/top count from the page's corner only while nothing positions
        // the icon's containing block; a site's `body { position: relative;
        // margin: 40px }` moves that corner, so correct by however far off we
        // landed. (No layout, as in jsdom, means nothing to correct.)
        const h = icon.host.getBoundingClientRect();
        const dx = h.left - x;
        const dy = h.top - y;
        if (h.width > 0 && (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5)) {
            this.place(icon, left - dx, top - dy);
        }
    }

    private place(icon: FieldIcon, left: number, top: number) {
        icon.host.style.setProperty(LEFT_VAR, left + "px", "important");
        icon.host.style.setProperty(TOP_VAR, top + "px", "important");
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
        const top = this.siteElementAt(icon, x, y);
        if (!top) return undefined;
        return top === icon.box || top === icon.element;
    }

    // The topmost element at x/y that isn't one of our icons; null if it can't
    // be told (off-screen, or no hit-testing as in jsdom)
    private siteElementAt(icon: FieldIcon, x: number, y: number): Element | null {
        return siteElementAt(icon.box.getRootNode(), x, y);
    }

    // Is something from elsewhere on the page over the icon's spot? What the
    // field's own wrappers lay over it (an eye toggle, a label, a decoration)
    // doesn't count: the icon was placed with those in mind.
    private isCoveredBySite(icon: FieldIcon, rect: DOMRect): boolean {
        const x =
            icon.side === "right"
                ? rect.right - ICON_INSET - ICON_SIZE / 2
                : rect.left + ICON_INSET + ICON_SIZE / 2;
        const top = this.siteElementAt(icon, x, rect.top + rect.height / 2);
        if (!top || top === icon.box || top === icon.element) return false;
        return !fieldSurroundings(icon.box).contains(top);
    }

    private applySide(icon: FieldIcon, side: IconSide) {
        if (icon.side === side) return;
        icon.side = side;
        this.restoreStyles(icon);
        if (side !== "left") return;

        // Move the field's text out from under the icon
        const style = window.getComputedStyle(icon.box);
        const paddingLeft = parseFloat(style.paddingLeft) || 0;
        if (paddingLeft >= TEXT_START) {
            // Already enough room
        } else if (style.boxSizing === "border-box") {
            this.setStyle(icon, icon.box, "padding-left", `${TEXT_START}px`);
        } else {
            // Extra padding would make a content-box field wider and could break
            // the site's layout, so indent the text instead
            const indent = parseFloat(style.textIndent) || 0;
            this.setStyle(icon, icon.box, "text-indent", `${indent + TEXT_START - paddingLeft}px`);
        }

        // and any label laid over it. The margin shrinks a label that is pinned
        // on both sides instead of pushing it out past the field's right edge.
        const textStart = icon.box.getBoundingClientRect().left + TEXT_START;
        for (const label of overlaidLabels(icon.box, icon.element)) {
            // With its transition running (GMX animates "all") a label still
            // reports where it was, e.g. shifted by us just before the icons were
            // redrawn, so measure and move it with the transition switched off
            const s = label.style;
            const transition = s.getPropertyValue("transition");
            const priority = s.getPropertyPriority("transition");
            s.setProperty("transition", "none", "important");
            const shift = textStart - label.getBoundingClientRect().left;
            if (shift > 0) {
                const margin = parseFloat(window.getComputedStyle(label).marginLeft) || 0;
                this.setStyle(icon, label, "margin-left", `${margin + shift}px`);
                // Settle the new position before the transition is back
                label.getBoundingClientRect();
            }
            s.setProperty("transition", transition, priority);
            this.ownStyles.set(label, label.getAttribute("style"));
        }
    }

    private setStyle(icon: FieldIcon, element: HTMLElement, property: string, value: string) {
        const s = element.style;
        icon.savedStyles.push({
            element,
            property,
            value: s.getPropertyValue(property),
            priority: s.getPropertyPriority(property)
        });
        s.setProperty(property, value, "important");
        this.ownStyles.set(element, element.getAttribute("style"));
    }

    private restoreStyles(icon: FieldIcon) {
        for (const { element, property, value, priority } of icon.savedStyles.reverse()) {
            element.style.setProperty(property, value, priority);
            this.ownStyles.set(element, element.getAttribute("style"));
        }
        icon.savedStyles = [];
    }

    private showMatchedLoginsPanel(icon: FieldIcon) {
        if (this.parentFrameId !== 0) {
            this.myPort.postMessage({
                action: Action.ShowMatchedLoginsPanel
            } as AddonMessage);
        } else {
            this.createMatchedLoginsPanelNearNode(icon.box, icon.side ?? "left");
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
