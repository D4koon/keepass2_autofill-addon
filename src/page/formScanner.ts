import { MatchedField } from "./MatchedField";
import { FormUtils } from "./formsUtils";
import { FormSaving } from "./formSaving";
import { FrameMatchState } from "./frameMatchState";
import { KeeLogger, KeeLog } from "../common/Logger";
import { configManager } from "../common/ConfigManager";
import type { FindMatchesBehaviour } from "./findMatchesBehaviour";
import { SubmitButtonDeps, findSubmitButton } from "./submitButtonFinder";
import punycode from "punycode/";

// The per-frame form scan, extracted verbatim from FormFilling: enumerate the
// frame's forms (including shadow-DOM forms and a pseudo-form of orphaned
// inputs), classify each as a login form, record its fields on the
// FrameMatchState and fire a single KPRPC search.

export interface FormScannerDeps {
    logger: KeeLogger;
    formUtils: FormUtils;
    state: FrameMatchState;
    matchFinder: (uri: string) => void;
    submitButtonDeps: SubmitButtonDeps;
    formSaving: Pick<FormSaving, "addSubmitHandler">;
}

type LoginForm = {
    index: number;
    usernameIndex: number;
    passwordFields: MatchedField[];
    otherFields: MatchedField[];
    submitTargetNeighbour: HTMLElement;
};

// What a scan found that matters for filling: each login form and its fields,
// and whether each field is visible. The orphaned-fields pseudo form is a new
// object on every scan, so it counts by its fields only.
function scanSignature(
    forms: HTMLFormElement[],
    pseudoForm: unknown,
    loginForms: LoginForm[],
    formUtils: FormUtils
): unknown[] {
    const signature: unknown[] = [];
    for (const found of loginForms) {
        const form = forms[found.index];
        signature.push(
            form === pseudoForm ? "pseudo-form" : form,
            found.usernameIndex,
            // Tells a password field from the same element as a text field
            found.passwordFields?.length ?? 0
        );
        for (const f of [...(found.passwordFields ?? []), ...(found.otherFields ?? [])]) {
            const element = f?.DOMelement;
            signature.push(element, !!element && formUtils.isDOMElementVisible(element));
        }
    }
    return signature;
}

function sameSignature(a: unknown[], b: unknown[] | null) {
    return !!b && a.length === b.length && a.every((v, i) => v === b[i]);
}

// onlyIfChanged: for the rescans the page's DOM mutation observer asks for. If
// the login fields found are the same as last time, leave everything as it is
// (icons, state, no new KeePass search) instead of going round again.
export function scanFrameForForms(
    behaviour: FindMatchesBehaviour,
    deps: FormScannerDeps,
    onlyIfChanged = false
) {
    const { logger, formUtils, state } = deps;
    // A web component can attach its shadow root without any DOM change the
    // mutation observer would see, so look for shadow roots afresh once per scan
    formUtils.invalidateShadowCache();

    if (window.document.forms.length > 50) {
        logger.debug(
            "Too many forms on this page. Assuming it is not a login page" +
                " and avoiding looking for login forms in order to avoid performance impact."
        );
    }

    // Can't append to a HTMLCollection but all we really use it for is iteration
    // and length so converting to an array sometimes will cause no issues
    let forms = new Array<HTMLFormElement>();
    for (let i = 0; i < window.document.forms.length; i++) {
        forms.push(window.document.forms.item(i));
    }

    // <form> elements that live inside an open shadow root are not in
    // document.forms, so add them explicitly (deduplicated).
    try {
        const shadowForms = formUtils
            .deepQueryAll<HTMLFormElement>(window.document, "form")
            .filter(f => forms.indexOf(f) === -1);
        if (shadowForms.length > 0) {
            forms = Array.prototype.slice.call(forms).concat(shadowForms);
            logger.debug("found " + shadowForms.length + " form(s) inside shadow DOM");
        }
    } catch (e) {
        logger.debug("shadow form scan failed: " + e);
    }

    // Forcing a scan for orphaned fields on all pages. May need to change
    // this if real world performance is too slow.
    const pseudoForm = scanForOrphanedFields(window.document, deps);
    if (pseudoForm) {
        forms = Array.prototype.slice.call(forms);
        forms.push(pseudoForm);
    }

    if (!forms || forms.length == 0) {
        logger.info("No forms found on this page.");
        state.lastScanSignature = null;
        return;
    }

    const url = new URL(window.document.URL);
    url.hostname = punycode.toUnicode(url.hostname);

    logger.info("Finding matches in a document. readyState: " + window.document.readyState);

    const conf = configManager.siteConfigFor(url.href);

    logger.debug("findMatches processing " + forms.length + " forms");

    // First find the login forms, without touching the state yet: a rescan that
    // finds just what the last scan found stops here
    const loginForms: LoginForm[] = [];
    for (let i = 0; i < forms.length; i++) {
        const form = forms[i];

        logger.debug("about to get form fields");
        let scanResult: {
            otherFields: MatchedField[];
            actualUsernameIndex?: number;
            pwFields?: MatchedField[];
        };
        try {
            scanResult = formUtils.getFormFields(form, false, 50);
        } catch (e) {
            logger.debug("Lost interest in this form after finding too many fields" + e);
            continue;
        }
        let usernameIndex = scanResult.actualUsernameIndex;
        const passwordFields = scanResult.pwFields;
        let otherFields = scanResult.otherFields;

        // The stand-in form gathers the loose fields of the whole page, so a
        // blacklisted field among them (the app's search box) mustn't rule out the
        // login fields too, as it rightly does for a real search <form>. Leave out
        // just that field.
        if (form === pseudoForm) {
            const username = otherFields[usernameIndex];
            const kept = otherFields.filter(f => !configManager.isFieldExcluded(f.field, conf));
            if (kept.length < otherFields.length) {
                logger.debug(
                    `Left ${otherFields.length - kept.length} blacklisted field(s) out of the stand-in form`
                );
                otherFields = kept;
                usernameIndex = Math.max(0, kept.indexOf(username));
            }
        }

        // We want to fill in this form if we find a password field but first
        // we check whether any whitelist or blacklist entries must override that behaviour
        let interestingForm: boolean = null;

        interestingForm = configManager.isFormInteresting(
            form,
            conf,
            otherFields.map(f => f.field)
        );

        if (interestingForm === false) {
            logger.debug("Lost interest in this form after inspecting field names and IDs");
            continue;
        }

        const noPasswordField =
            passwordFields == null || passwordFields.length <= 0 || passwordFields[0] == null;
        const noOtherField =
            usernameIndex < 0 ||
            otherFields == null ||
            otherFields.length <= 0 ||
            otherFields[usernameIndex] == null;

        if (noPasswordField && (noOtherField || interestingForm !== true)) {
            logger.debug(
                "No password field found in this form and either there are no other" +
                    " fields or no whitelisted text field or form element"
            );
            continue;
        }

        let submitTargetNeighbour: HTMLElement;
        if (noPasswordField) {
            submitTargetNeighbour = otherFields[usernameIndex].DOMelement;
        } else {
            submitTargetNeighbour = passwordFields[0].DOMelement;
        }

        loginForms.push({
            index: i,
            usernameIndex,
            passwordFields,
            otherFields,
            submitTargetNeighbour
        });
    }

    const signature = scanSignature(forms, pseudoForm, loginForms, formUtils);
    if (onlyIfChanged && sameSignature(signature, state.lastScanSignature)) {
        logger.debug("Rescan found the same login fields as before; nothing to do");
        return;
    }
    state.lastScanSignature = signature;

    state.reset(behaviour);
    state.current.forms = forms;
    for (let i = 0; i < forms.length; i++) {
        state.current.entries[i] = [];

        // the overall relevance of this form is the maximum of it's
        // matching entries (so we fill the most relevant form)
        state.current.formFits[i] = null;
    }

    let searchSentToKeePass = false;

    for (const found of loginForms) {
        const i = found.index;
        const form = forms[i];

        attachSubmitHandlers(form, found.submitTargetNeighbour, i, deps);

        state.current.usernameIndexArray[i] = found.usernameIndex;
        state.current.passwordFieldsArray[i] = found.passwordFields;
        state.current.otherFieldsArray[i] = found.otherFields;
        state.current.submitTargets[i] = found.submitTargetNeighbour;

        // The entries returned from KeePass for every form will be identical (based on tab/frame URL)
        if (!searchSentToKeePass) {
            state.loginOp.forms = forms;
            state.loginOp.formIndexes = [i];

            // Search for matching entries for the relevant URL. This request is asynchronous.
            deps.matchFinder(url.href);
            searchSentToKeePass = true;
        } else {
            logger.debug("form[" + i + "]: reusing entries from last form.");
            state.loginOp.formIndexes.push(i);
        }
    } // end of form for loop
}

// It's OK for this to take a few seconds - humans can't type that fast.
// By making this async we allow the search for entries to begin earlier
// and reduce perceived impact on page load time
async function attachSubmitHandlers(
    form: HTMLFormElement,
    submitTargetNeighbour: HTMLElement,
    formNumber: number,
    deps: FormScannerDeps
) {
    try {
        await Promise.resolve();
        const start = performance.now();
        const submitTarget = findSubmitButton(form, submitTargetNeighbour, deps.submitButtonDeps);
        deps.formSaving.addSubmitHandler(submitTarget, form);
        KeeLog.info(
            "Submit handlers attached asynchronously to form " +
                formNumber +
                " in " +
                (performance.now() - start) +
                "ms"
        );
    } catch (e) {
        KeeLog.warn("Exception while adding submit handler. Message: " + e.message);
    }
}

function scanForOrphanedFields(doc, deps: FormScannerDeps) {
    const t = new Date().getTime();
    const orphanedFields = [];
    let pseudoForm = null;

    // much faster than querySelectorAll
    const items = doc.getElementsByTagName("input");
    for (const tag of items) {
        if (!tag.form) orphanedFields.push(tag);
    }

    // Inputs inside open shadow roots are never in doc.getElementsByTagName
    // and (not being form-associated) have no .form, so treat them as orphans
    // too. This is what makes web-component logins (Lit/Polymer/etc.) fillable.
    // Only credential-ish types: a dashboard's shadow DOM can hold hundreds of
    // range/checkbox controls which would blow the pseudo-form field limit.
    const loginInputTypes = new Set([
        "",
        "text",
        "password",
        "email",
        "tel",
        "url",
        "search",
        "number"
    ]);
    try {
        const shadowInputs = deps.formUtils.deepQueryAll<HTMLInputElement>(doc, "input");
        for (const tag of shadowInputs) {
            if (
                !tag.form &&
                // Inside a shadow host that is in a <form>: getFormFields lists it there
                !deps.formUtils.getShadowHostForm(tag) &&
                loginInputTypes.has((tag.getAttribute("type") || "").toLowerCase()) &&
                orphanedFields.indexOf(tag) === -1
            ) {
                orphanedFields.push(tag);
            }
        }
    } catch (e) {
        deps.logger.debug("shadow orphan-field scan failed: " + e);
    }

    if (orphanedFields.length > 0) {
        pseudoForm = {
            elements: orphanedFields,
            id: "Kee-pseudo-form",
            name: "Kee-pseudo-form",
            ownerDocument: doc,
            getElementsByTagName: function () {
                return this.elements;
            }, // Only use is for listing input elements
            querySelectorAll: function () {
                return [];
            }, // Only use is for listing button elements
            submit: function () {
                return;
            }, // Not possible to submit a pseudo form unless a button with custom JS has already been found
            offsetParent: true, // This tricks element visibility checks into treating this as visible to the user
            addEventListener: function () {
                return;
            }, //TODO:5: hook up to the submit function to simulate real form submission
            removeEventListener: function () {
                return;
            }
        };
    }

    const tn = new Date().getTime();
    deps.logger.debug("scanForOrphanedFields took: " + (tn - t));

    return pseudoForm;
}
