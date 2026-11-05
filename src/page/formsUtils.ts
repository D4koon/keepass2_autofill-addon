import { KeeLogger } from "../common/Logger";
import { MatchedField } from "./MatchedField";
import { Field } from "../common/model/Field";

/*
  This contains code related to the management and manipulation of forms and form fields.
*/

// A form control as the field scan reads it (input, select, textarea, ...)
type FormControl = HTMLInputElement & { keeInitialDetectedValue?: string };

export class FormUtils {
    Logger: KeeLogger;

    constructor(logger: KeeLogger) {
        this.Logger = logger;
    }

    countAllDocuments(frame: Window) {
        if (!this.isUriWeCanFill(frame.location)) return 0;

        let localDocCount = 1;

        if (frame.frames.length > 0) {
            const frames = frame.frames;
            for (let i = 0; i < frames.length; i++) {
                localDocCount += this.countAllDocuments(frames[i]);
            }
        }
        return localDocCount;
    }

    isUriWeCanFill(uri) {
        if (uri.protocol == "http:" || uri.protocol == "https:" || uri.protocol == "file:") {
            return true;
        }
        return false;
    }

    isATextFormFieldType(type) {
        if (
            type == "checkbox" ||
            type == "select-one" ||
            type == "radio" ||
            type == "password" ||
            type == "hidden" ||
            type == "submit" ||
            type == "button" ||
            type == "file" ||
            type == "image" ||
            type == "reset"
        ) {
            return false;
        } else return true;
    }

    private isAKnownUsernameString(fieldNameIn) {
        const fieldName = fieldNameIn.toLowerCase();
        if (
            fieldName == "username" ||
            fieldName == "j_username" ||
            fieldName == "user_name" ||
            fieldName == "user" ||
            fieldName == "user-name" ||
            fieldName == "login" ||
            fieldName == "vb_login_username" ||
            fieldName == "name" ||
            fieldName == "user name" ||
            fieldName == "user id" ||
            fieldName == "user-id" ||
            fieldName == "userid" ||
            fieldName == "email" ||
            fieldName == "e-mail" ||
            fieldName == "id" ||
            fieldName == "form_loginname" ||
            fieldName == "wpname" ||
            fieldName == "mail" ||
            fieldName == "loginid" ||
            fieldName == "login id" ||
            fieldName == "login_name" ||
            fieldName == "openid_identifier" ||
            fieldName == "authentication_email" ||
            fieldName == "openid" ||
            fieldName == "auth_email" ||
            fieldName == "auth_id" ||
            fieldName == "authentication_identifier" ||
            fieldName == "authentication_id" ||
            fieldName == "customer_number" ||
            fieldName == "customernumber" ||
            fieldName == "onlineid"
        ) {
            // etc. etc.
            return true;
        }
        return false;
    }

    /*
     * getFormFields
     *
     * Returns the usernameIndex and password fields found in the form.
     * Can handle complex forms by trying to figure out what the
     * relevant fields are.
     *
     * Returns: [usernameIndex, passwords, ...]
     * all arrays are standard javascript arrays
     * usernameField may be null.
     */
    public getFormFields(form, isSubmission: boolean, maximumFieldCount: number) {
        const pwFields: MatchedField[] = [];
        const otherFields: MatchedField[] = [];
        const allFields: {
            index: number;
            element: MatchedField;
            type: string;
        }[] = [];
        let firstPasswordIndex = -1;
        let firstPossibleUsernameIndex = -1;
        let usernameIndex = -1;

        // search the DOM for any form fields we might be interested in
        const elements = this.getFormElements(form);
        const totalElements = elements.length;
        const elementLimit = totalElements < 2000 ? totalElements : 2000;
        for (let i = 0; i < elementLimit; i++) {
            if (allFields.length > maximumFieldCount) {
                throw new Error("Too many fields");
            }
            if (
                elements[i].localName.toLowerCase() == "object" ||
                elements[i].localName.toLowerCase() == "keygen" ||
                elements[i].localName.toLowerCase() == "output" ||
                (elements[i].localName.toLowerCase() != "input" &&
                    (elements[i].type == undefined || elements[i].type == null))
            ) {
                continue; // maybe it's something un-interesting
            }

            const domType: string = elements[i].type.toLowerCase();

            if (domType == "fieldset") continue; // not interested in fieldsets

            if (
                domType != "password" &&
                !this.isATextFormFieldType(domType) &&
                domType != "checkbox" &&
                domType != "radio" &&
                domType != "select-one"
            ) {
                continue; // ignoring other form types
            }

            if (domType == "radio" && isSubmission && elements[i].checked == false) continue;
            if (domType == "password" && isSubmission && !elements[i].value) continue;
            if (domType == "select-one" && isSubmission && !elements[i].value) continue;

            this.Logger.debug(`processing field with domtype ${domType}...`);
            allFields[allFields.length] = {
                index: i,
                element: new MatchedField(),
                type: domType
            };
            let fieldValue = elements[i].value;
            if (domType == "checkbox") {
                if (elements[i].checked) fieldValue = "KEEFOX_CHECKED_FLAG_TRUE";
                else fieldValue = "KEEFOX_CHECKED_FLAG_FALSE";
            }
            const field = Field.fromDOM(elements[i], domType, fieldValue);
            allFields[allFields.length - 1].element.field = field;
            allFields[allFields.length - 1].element.DOMelement = elements[i];

            if (domType == "password" && firstPasswordIndex == -1) {
                firstPasswordIndex = allFields.length - 1;
            }

            if (
                this.isATextFormFieldType(domType) &&
                firstPossibleUsernameIndex == -1 &&
                (this.isAKnownUsernameString(elements[i].name) ||
                    field.locators[0].labels?.some(label => this.isAKnownUsernameString(label)))
            ) {
                firstPossibleUsernameIndex = allFields.length - 1;
            }

            if (elements[i].keeInitialDetectedValue == null) {
                elements[i].keeInitialDetectedValue = fieldValue;
            }
        }

        // Work out which DOM form element is most likely to be the username field.
        // This information is only used to display the username to the user so an inaccurate
        // choice won't impact the form detection or filling behaviour.
        //TODO:5: Extend this to inspect more than just the name of the field. E.g. max length?
        //TODO:5: For form filling (not submitting) we might want to select based upon found data in KeePass?
        if (firstPossibleUsernameIndex != -1) usernameIndex = firstPossibleUsernameIndex;
        else if (firstPasswordIndex > 0) usernameIndex = firstPasswordIndex - 1;
        this.Logger.debug("usernameIndex: " + usernameIndex);

        let otherCount = 0;
        let actualUsernameIndex = 0;

        // separate the field data into appropriate variables
        for (let i = 0; i < allFields.length; i++) {
            if (allFields[i].type == "password") pwFields[pwFields.length] = allFields[i].element;
            else if (
                this.isATextFormFieldType(allFields[i].type) ||
                allFields[i].type == "checkbox" ||
                allFields[i].type == "radio" ||
                allFields[i].type == "select-one"
            ) {
                otherFields[otherFields.length] = allFields[i].element;
                if (i == usernameIndex) actualUsernameIndex = otherCount;
                else otherCount++;
            }
        }

        this.Logger.debug("actualUsernameIndex: " + actualUsernameIndex);
        this.Logger.debug("otherFields.length:" + otherFields.length);

        return {
            actualUsernameIndex,
            pwFields,
            otherFields
        };
    }

    // ------------------------------------------------------------------
    // Shadow DOM traversal
    //
    // Kee's normal form/field discovery only walks the light DOM. Many modern
    // sites (anything built with Lit/Polymer/Stencil web components - e.g. Home
    // Assistant) render their login inputs inside open shadow roots, so none of
    // the light-DOM queries ever see them. These helpers walk open shadow roots
    // as well, with hard limits so a pathological page cannot hang the scan.
    // Closed shadow roots are not accessible to any script and are skipped.
    // ------------------------------------------------------------------

    private static readonly SHADOW_NODE_LIMIT = 15000;
    private static readonly SHADOW_DEPTH_LIMIT = 10;

    private shadowRootCache: {
        root: ParentNode;
        generation: number;
        roots: ShadowRoot[];
    } = null;
    private shadowGeneration = 0;

    // Call when the DOM changed in a way that could add/remove shadow hosts, so
    // the next getOpenShadowRoots() rebuilds instead of returning a stale list.
    public invalidateShadowCache() {
        this.shadowGeneration++;
    }

    // Collect every open shadow root at or below `root`. For the whole page (the
    // document or its body) the result is cached until invalidateShadowCache() is
    // called (each scan starts with that, and the mutation observer does it on
    // relevant DOM changes), so the several lookups of one scan walk the page once.
    // Any other root, such as the element the mutation observer is checking, is
    // walked fresh and leaves the page's cached list alone.
    public getOpenShadowRoots(root: ParentNode): ShadowRoot[] {
        const doc = (root as Node).ownerDocument ?? (root as Document);
        if (root === doc.body) root = doc;
        if (root !== doc) return this.walkOpenShadowRoots(root);
        if (
            this.shadowRootCache &&
            this.shadowRootCache.root === root &&
            this.shadowRootCache.generation === this.shadowGeneration
        ) {
            return this.shadowRootCache.roots;
        }
        const result = this.walkOpenShadowRoots(root);
        this.shadowRootCache = {
            root,
            generation: this.shadowGeneration,
            roots: result
        };
        return result;
    }

    private walkOpenShadowRoots(root: ParentNode): ShadowRoot[] {
        const roots: ShadowRoot[] = [];
        let budget = FormUtils.SHADOW_NODE_LIMIT;
        const visit = (node: ParentNode, depth: number) => {
            if (depth > FormUtils.SHADOW_DEPTH_LIMIT || budget <= 0) return;
            let els: Element[];
            try {
                els = Array.from(node.querySelectorAll("*"));
            } catch (e) {
                return;
            }
            for (const el of els) {
                if (--budget <= 0) return;
                const sr = (el as { shadowRoot?: ShadowRoot }).shadowRoot;
                if (sr) {
                    roots.push(sr);
                    visit(sr, depth + 1);
                }
            }
        };
        visit(root, 0);
        return roots;
    }

    // Light DOM + every open shadow root beneath `root`, flattened.
    public deepQueryAll<E extends Element = Element>(
        root: ParentNode,
        selector: string
    ): E[] {
        const out: E[] = [];
        try {
            out.push(...(Array.from(root.querySelectorAll(selector)) as E[]));
        } catch (e) {
            /* invalid selector - caller's problem, not ours */
        }
        for (const sr of this.getOpenShadowRoots(root)) {
            try {
                out.push(...(Array.from(sr.querySelectorAll(selector)) as E[]));
            } catch (e) {
                /* ignore */
            }
        }
        return out;
    }

    // Fast existence check for the mutation observer's "is this worth a rescan?"
    public deepContains(root: ParentNode, selectors: string[]): boolean {
        for (const s of selectors) {
            try {
                if (root.querySelector(s)) return true;
            } catch (e) {
                /* ignore */
            }
        }
        for (const sr of this.getOpenShadowRoots(root)) {
            for (const s of selectors) {
                try {
                    if (sr.querySelector(s)) return true;
                } catch (e) {
                    /* ignore */
                }
            }
        }
        return false;
    }

    // A form's fields, including inputs inside open shadow roots of elements in
    // the form (e.g. <lux-password> on auth.gmx.net). Such inputs aren't in
    // form.elements and have no .form, but to the user they're part of the form.
    // Kept in document order, by shadow host, so username-before-password
    // detection still works.
    public getFormElements(form): FormControl[] {
        const light = Array.from(form.elements ?? []) as FormControl[];
        // The orphaned-fields pseudo-form already lists shadow inputs itself
        if (!(form instanceof HTMLFormElement)) return light;
        const formRoot = form.getRootNode();
        // The page's shadow roots whose host is (via any outer hosts) in the form
        const inForm = (sr: ShadowRoot) => {
            let host: Element = sr.host;
            while (host.getRootNode() !== formRoot) {
                const r = host.getRootNode();
                if (!(r instanceof ShadowRoot)) return false;
                host = r.host;
            }
            return form.contains(host);
        };
        const roots = this.getOpenShadowRoots(form.ownerDocument).filter(inForm);
        if (roots.length === 0) return light;

        const shadowInputs: FormControl[] = [];
        for (const sr of roots) {
            for (const input of Array.from(sr.querySelectorAll("input"))) {
                // Inputs of a <form> inside the shadow root belong to that form
                if (!input.form) shadowInputs.push(input);
            }
        }
        if (shadowInputs.length === 0) return light;

        // Position in the light DOM: the outermost shadow host
        const anchor = (el: Element) => {
            let node: Element = el;
            let root = node.getRootNode();
            while (root instanceof ShadowRoot) {
                node = root.host;
                root = node.getRootNode();
            }
            return node;
        };
        // Array.prototype.sort is stable, so inputs sharing a host keep their order
        return light.concat(shadowInputs).sort((a, b) => {
            const x = anchor(a);
            const y = anchor(b);
            if (x === y) return 0;
            return x.compareDocumentPosition(y) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
        });
    }

    // The light-DOM <form> an input inside a shadow root sits in, via its shadow
    // host(s); null if none. Such inputs belong to that form, not the orphans.
    public getShadowHostForm(el: Element): HTMLFormElement | null {
        let root = el.getRootNode();
        while (root instanceof ShadowRoot) {
            const host = root.host;
            const form = host.closest("form");
            if (form) return form;
            root = host.getRootNode();
        }
        return null;
    }

    // Attach `observer` to every open shadow root under `root` that it is not
    // already watching, so mutations inside web components trigger a rescan.
    public observeOpenShadowRoots(
        observer: MutationObserver,
        root: ParentNode,
        options: MutationObserverInit
    ) {
        if (!this.observedShadowRoots) this.observedShadowRoots = new WeakSet<ShadowRoot>();
        for (const sr of this.getOpenShadowRoots(root)) {
            if (this.observedShadowRoots.has(sr)) continue;
            try {
                observer.observe(sr, options);
                this.observedShadowRoots.add(sr);
            } catch (e) {
                /* ignore */
            }
        }
    }

    private observedShadowRoots: WeakSet<ShadowRoot>;

    // A basic, slightly flawed but fast visibility test
    public isDOMElementVisible(element: HTMLElement) {
        if (!element.offsetParent && element.offsetHeight === 0 && element.offsetWidth === 0) {
            return false;
        }
        return true;
    }

    // // used for multipage stuff that we might not be able to support yet in webextensions
    // resetFormFillSession () {
    //     if (resetFormFillTimer != null) {
    //         clearTimeout(resetFormFillTimer);
    //         resetFormFillTimer = null;
    //     }
    //     tabState.currentPage = 0;
    //     tabState.maximumPage = 0;
    //     tabState.forceAutoSubmit = null;
    //     tabState.userRecentlyDemandedAutoSubmit = false;
    //     Logger.debug("Reset form-filling session (page = 0 and cancelled any forced autosubmit).");
    // };
    //var resetFormFillTimer = null;
}
