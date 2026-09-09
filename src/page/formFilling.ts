import { PanelStub } from "./PanelStub";
import { MatchedLoginsPanel } from "./matchedLoginsPanel";
import { FormUtils } from "./formsUtils";
import { FormSaving } from "./formSaving";
import { KeeFieldIcon } from "./keeFieldIcon";
import {
    FieldMatchScoreConfig,
    ScoringDeps,
    calculateRelevanceScore
} from "./relevanceScoring";
import { SubmitButtonDeps, findSubmitButton, submitForm } from "./submitButtonFinder";
import { FieldFillingDeps, fillManyFormFields } from "./fieldFilling";
import { decideFill, resolveFillTarget, shouldAnnounceEntries } from "./fillDecision";
import { MatchResult } from "./MatchResult";
import { FrameMatchState } from "./frameMatchState";
import { runFillDiagnosis } from "./fillDiagnostics";
import type { FindMatchesBehaviour } from "./findMatchesBehaviour";
import { KeeLogger, KeeLog } from "../common/Logger";
import { Config } from "../common/config";
import { configManager } from "../common/ConfigManager";
import { MatchedField } from "./MatchedField";
import { Field } from "../common/model/Field";
import { Entry } from "../common/model/Entry";
import punycode from "punycode/";
import NonReactiveStore from "../store/NonReactiveStore";

export class FormFilling {
    private state = new FrameMatchState();
    private keeFieldIcon: KeeFieldIcon;
    private panel: MatchedLoginsPanel;

    // Kept for API parity; nothing outside this class reads it.
    public get matchedLoginsPanelStub(): PanelStub {
        return this.panel.stubInstance;
    }

    // Should really make this private and call indirectly but I'm wary of all performance overheads wrt DOM mutation observers
    public formFinderTimer: number = null;

    private scoringDeps: ScoringDeps;
    private submitButtonDeps: SubmitButtonDeps;
    private fieldFillingDeps: FieldFillingDeps;

    constructor(
        private store: NonReactiveStore,
        private myPort: chrome.runtime.Port,
        private parentFrameId: number,
        private formUtils: FormUtils,
        private formSaving: FormSaving,
        private Logger: KeeLogger,
        private config: Config,
        private matchFinder: { (uri: string): void }
    ) {
        this.scoringDeps = {
            isDOMElementVisible: el => this.formUtils.isDOMElementVisible(el),
            logger: this.Logger
        };
        this.submitButtonDeps = { formUtils: this.formUtils, logger: this.Logger };
        this.fieldFillingDeps = { logger: this.Logger, scoringDeps: this.scoringDeps };
        this.panel = new MatchedLoginsPanel(parentFrameId);
        this.keeFieldIcon = new KeeFieldIcon(
            myPort,
            parentFrameId,
            formUtils,
            this.panel.createNearNode.bind(this.panel)
        );
    }

    public executePrimaryAction() {
        if (
            this.state.current.entries &&
            this.state.current.entries.length > 0 &&
            this.state.current.mostRelevantFormIndex != null &&
            this.state.current.mostRelevantFormIndex >= 0
        ) {
            if (this.state.current.entries[this.state.current.mostRelevantFormIndex].length == 1) {
                this.fillAndSubmit(false, this.state.current.mostRelevantFormIndex, 0);
                this.closeMatchedLoginsPanel();
            } else if (
                this.state.current.entries[this.state.current.mostRelevantFormIndex].length > 1
            ) {
                this.closeMatchedLoginsPanel();
                this.panel.createInCenter(this.parentFrameId);
            }
        }
    }

    public createMatchedLoginsPanelInCenter(specificFrameId: number) {
        this.panel.createInCenter(specificFrameId);
    }

    public createMatchedLoginsPanelNearNode(target: HTMLElement) {
        this.panel.createNearNode(target);
    }

    public closeMatchedLoginsPanel() {
        this.panel.close();
    }

    // Requires KeePassRPC #101
    // private calculateLabelMatchScore(matchedField: MatchedField, dataField: Field) {
    //     if (!matchedField.field.name || !dataField.name) return 0;

    //     // We only persist a single "label" value, implicitly via the display name
    //     // field. Could change this in future with additional features added to the
    //     // KeePassRPC libraries.
    //     if (
    //         matchedField.field.locators[0].labels.some(
    //             matchedFieldLabel =>
    //                 matchedFieldLabel.toLowerCase() === dataField.name.toLowerCase()
    //         )
    //     ) {
    //         return 100;
    //     }

    //     const weakMatchLabels = [dataField.name.toLowerCase()];
    //     if (dataField.name !== dataField.locators[0].name) {
    //         weakMatchLabels.push(dataField.locators[0].name.toLowerCase());
    //     }

    //     if (
    //         matchedField.field.locators[0].labels.some(matchedFieldLabel => {
    //             weakMatchLabels.some(
    //                 dataLabel => matchedFieldLabel.toLowerCase().indexOf(dataLabel) >= 0
    //             );
    //         })
    //     ) {
    //         return 30;
    //     }
    //     return 0;
    // }

    /* Expects this data object:
    {
        autofillOnSuccess: true, // This won't override other configuration options if true but if false it will.
        autosubmitOnSuccess: true, // This won't override other configuration options if true but if false it will.
        notifyUserOnSuccess: true, // e.g. used when periodic form polling finds a form after the page has loaded.
        ... others
    }
    */
    public findMatchesInThisFrame(behaviour: FindMatchesBehaviour = {}) {
        // Whether or not this was invoked as a result of a DOM mutation, we won't need the timer to fire anymore
        if (this.formFinderTimer !== null) {
            clearTimeout(this.formFinderTimer);
            this.formFinderTimer = null;
        }

        if (window.document.forms.length > 50) {
            this.Logger.debug(
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
            const shadowForms = this.formUtils
                .deepQueryAll<HTMLFormElement>(window.document, "form")
                .filter(f => forms.indexOf(f) === -1);
            if (shadowForms.length > 0) {
                forms = Array.prototype.slice.call(forms).concat(shadowForms);
                this.Logger.debug(
                    "found " + shadowForms.length + " form(s) inside shadow DOM"
                );
            }
        } catch (e) {
            this.Logger.debug("shadow form scan failed: " + e);
        }

        // Forcing a scan for orphaned fields on all pages. May need to change
        // this if real world performance is too slow.
        const pseudoForm = this.scanForOrphanedFields(window.document);
        if (pseudoForm) {
            forms = Array.prototype.slice.call(forms);
            forms.push(pseudoForm);
        }

        if (!forms || forms.length == 0) {
            this.Logger.info("No forms found on this page.");
            return;
        }

        const url = new URL(window.document.URL);
        url.hostname = punycode.toUnicode(url.hostname);

        this.Logger.info(
            "Finding matches in a document. readyState: " + window.document.readyState
        );

        this.state.reset(behaviour);
        this.state.current.forms = forms;

        const conf = configManager.siteConfigFor(url.href);

        this.Logger.debug("findMatches processing " + forms.length + " forms");

        let searchSentToKeePass = false;

        // For every form, including any pseudo forms we created earlier
        for (let i = 0; i < forms.length; i++) {
            const form = forms[i];
            this.state.current.entries[i] = [];

            // the overall relevance of this form is the maximum of it's
            // matching entries (so we fill the most relevant form)
            this.state.current.formRelevanceScores[i] = 0;

            this.Logger.debug("about to get form fields");
            let scanResult: {
                otherFields: MatchedField[];
                actualUsernameIndex?: number;
                pwFields?: MatchedField[];
            };
            try {
                scanResult = this.formUtils.getFormFields(form, false, 50);
            } catch (e) {
                this.Logger.debug("Lost interest in this form after finding too many fields" + e);
                continue;
            }
            const usernameIndex = scanResult.actualUsernameIndex;
            const passwordFields = scanResult.pwFields;
            const otherFields = scanResult.otherFields;

            // We want to fill in this form if we find a password field but first
            // we check whether any whitelist or blacklist entries must override that behaviour
            let interestingForm: boolean = null;

            interestingForm = configManager.isFormInteresting(
                form,
                conf,
                otherFields.map(f => f.field)
            );

            if (interestingForm === false) {
                this.Logger.debug(
                    "Lost interest in this form after inspecting field names and IDs"
                );
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
                this.Logger.debug(
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

            this.attachSubmitHandlers(form, submitTargetNeighbour, i);

            this.state.current.usernameIndexArray[i] = usernameIndex;
            this.state.current.passwordFieldsArray[i] = passwordFields;
            this.state.current.otherFieldsArray[i] = otherFields;
            this.state.current.submitTargets[i] = submitTargetNeighbour;

            // The entries returned from KeePass for every form will be identical (based on tab/frame URL)
            if (!searchSentToKeePass) {
                this.state.loginOp.forms = forms;
                this.state.loginOp.formIndexes = [i];
                this.state.loginOp.wrappedBy = this.state.current;
                this.state.current.wrappers[i] = this.state.loginOp;
                this.state.current.requestCount++;

                // Search for matching entries for the relevant URL. This request is asynchronous.
                this.matchFinder(url.href);
                searchSentToKeePass = true;
            } else {
                this.Logger.debug("form[" + i + "]: reusing entries from last form.");
                this.state.loginOp.formIndexes.push(i);
            }
        } // end of form for loop
    }

    // It's OK for this to take a few seconds - humans can't type that fast.
    // By making this async we allow the search for entries to begin earlier
    // and reduce perceived impact on page load time
    private async attachSubmitHandlers(
        form: HTMLFormElement,
        submitTargetNeighbour: HTMLElement,
        formNumber: number
    ) {
        try {
            await Promise.resolve();
            const start = performance.now();
            const submitTarget = findSubmitButton(
                form,
                submitTargetNeighbour,
                this.submitButtonDeps
            );
            this.formSaving.addSubmitHandler(submitTarget, form);
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

    private scanForOrphanedFields(doc) {
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
            const shadowInputs = this.formUtils.deepQueryAll<HTMLInputElement>(
                doc,
                "input"
            );
            for (const tag of shadowInputs) {
                if (
                    !tag.form &&
                    loginInputTypes.has((tag.getAttribute("type") || "").toLowerCase()) &&
                    orphanedFields.indexOf(tag) === -1
                ) {
                    orphanedFields.push(tag);
                }
            }
        } catch (e) {
            this.Logger.debug("shadow orphan-field scan failed: " + e);
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
        this.Logger.debug("scanForOrphanedFields took: " + (tn - t));

        return pseudoForm;
    }

    public findLoginsResultHandler(entries: Entry[]) {
        if (!entries) return;
        const validEntries = entries.filter(
            e => Entry.getUsernameField(e) || Entry.getPasswordField(e)
        );

        // Mutates this.state.current in place (and returns it); no reassignment.
        this.getRelevanceOfLoginMatchesAgainstAllForms(
            validEntries,
            this.state.loginOp,
            this.state.current
        );

        this.fillAndSubmit(true);
    }

    // Debugging aid for "this entry is findable in the search box but won't fill here".
    // Runs a single, explicitly chosen entry through the real form-scan + relevance
    // scoring pipeline against this frame, force-fills the best form (never submits) and
    // returns a plain-text report of what happened and why. Triggered from the popup
    // search results; the report is surfaced there as a notification.
    public diagnoseFillForEntry(rawEntry: Entry) {
        runFillDiagnosis(rawEntry, {
            logger: this.Logger,
            formUtils: this.formUtils,
            port: this.myPort,
            state: this.state,
            findMatchesInThisFrame: behaviour => this.findMatchesInThisFrame(behaviour),
            getRelevanceOfLoginMatchesAgainstAllForms: (entries, findLoginOp, matchResult) =>
                this.getRelevanceOfLoginMatchesAgainstAllForms(entries, findLoginOp, matchResult),
            getMostRelevantForm: formIndex => this.getMostRelevantForm(formIndex),
            fillAndSubmit: (automated, formIndex, entryIndex, noSubmit) =>
                this.fillAndSubmit(automated, formIndex, entryIndex, noSubmit)
        });
    }

    getRelevanceOfLoginMatchesAgainstAllForms(
        entries: Entry[],
        findLoginOp,
        matchResult: MatchResult
    ) {
        const crString = JSON.stringify(entries);
        let firstMatchProcessed = false;

        for (let i = 0; i < findLoginOp.forms.length; i++) {
            // Skip any form that we don't want to match against this set of entries
            if (findLoginOp.formIndexes.indexOf(i) == -1) continue;

            // if there is more than one form, we have to work with clones of the entry so
            // that we can manipulate the relevancy scores, etc. independently for each
            // form and entry combination. We could be more efficient for the common case of 1 form
            // by avoiding the clone then but keeping the same behaviour gives us a higher chance
            // of noticing bugs.
            matchResult.entries[i] = JSON.parse(crString); //TODO:5: faster clone? https://developer.mozilla.org/en-US/docs/Web/Guide/API/DOM/The_structured_clone_algorithm ?

            // Nothing to do if we have no matching entries available.
            if (matchResult.entries[i].length == 0) continue;

            this.Logger.info("match found!");

            const formVisible = this.formUtils.isDOMElementVisible(matchResult.submitTargets[i]);
            this.Logger.debug("formVisible: " + formVisible);

            const visibleFieldCache = {
                other: matchResult.otherFieldsArray[i].map(f =>
                    this.formUtils.isDOMElementVisible(f.DOMelement)
                ),
                password: matchResult.passwordFieldsArray[i].map(f =>
                    this.formUtils.isDOMElementVisible(f.DOMelement)
                )
            };

            // determine the relevance of each entry to this form
            // we could skip this when autofilling based on uuid but we would have to check for
            // matches first or else we risk no match and no alternative matching entries on the mainUI
            // and we also now consider the totality of possible matches against a field in order
            // to limit which fields we shove a Kee icon into.
            for (let v = 0; v < matchResult.entries[i].length; v++) {
                const features = this.store.state.KeePassDatabases.find(
                    db => db.fileName === matchResult.entries[i][v].database.fileName
                ).sessionFeatures;
                const fieldMatchScoreConfig: FieldMatchScoreConfig = {
                    punishWrongIDAndName:
                        features.indexOf("KPRPC_FIELD_DEFAULT_NAME_AND_ID_EMPTY") >= 0
                };
                const { score, lowFieldMatchRatio } = calculateRelevanceScore(
                    matchResult.entries[i][v],
                    matchResult.passwordFieldsArray[i],
                    matchResult.otherFieldsArray[i],
                    matchResult.currentPage,
                    formVisible,
                    fieldMatchScoreConfig,
                    visibleFieldCache,
                    this.scoringDeps
                );

                // choosing best form should not be affected by lowFieldMatchRatio entry score
                // but when we come to fill the form we can force ourselves into a no-auto-fill behaviour.
                matchResult.entries[i][v].relevanceScore = score;
                matchResult.entries[i][v].lowFieldMatchRatio = lowFieldMatchRatio;

                // also set the form index and entry index on the internal entry object so
                // it will persist when later passed to the UI and we can ultimately
                // find the same entry object when processing a matched entry
                matchResult.entries[i][v].formIndex = i;
                matchResult.entries[i][v].entryIndex = v;

                // Remember the best form for each entry
                if (
                    !firstMatchProcessed ||
                    matchResult.entries[i][v].relevanceScore >
                        matchResult.allMatchingLogins[v].relevanceScore
                ) {
                    this.Logger.debug(
                        "Higher relevance score found for entry " +
                            v +
                            " with formIndex " +
                            matchResult.entries[i][v].formIndex +
                            " (" +
                            findLoginOp.forms[i].id +
                            ")"
                    );
                    matchResult.allMatchingLogins[v] = matchResult.entries[i][v];
                }
            }
            firstMatchProcessed = true;

            // Find the best entry for this form
            matchResult.entries[i].forEach(function (c) {
                if (c.relevanceScore > matchResult.formRelevanceScores[i]) {
                    matchResult.formRelevanceScores[i] = c.relevanceScore;
                }
            });

            this.Logger.debug(
                "Relevance of form " +
                    i +
                    " (" +
                    findLoginOp.forms[i].id +
                    ") is " +
                    matchResult.formRelevanceScores[i]
            );
        }
        return matchResult;
    }

    getMostRelevantForm(formIndex?: number) {
        const findMatchesResult = this.state.current;

        // There may be no results for this frame (e.g. no forms found, search failed, etc.)
        if (!findMatchesResult) {
            return {
                bestFormIndex: 0,
                bestRelevanceScore: 0,
                bestFindMatchesResult: undefined
            };
        }

        let mostRelevantFormIndex = 0;

        if (formIndex >= 0) mostRelevantFormIndex = formIndex;
        else {
            findMatchesResult.formRelevanceScores.forEach((c, index) => {
                this.Logger.debug("Relevance of form is " + c);
                if (c > findMatchesResult.formRelevanceScores[mostRelevantFormIndex]) {
                    mostRelevantFormIndex = index;
                }
            });
        }

        this.Logger.debug("The most relevant form is #" + mostRelevantFormIndex);
        return {
            bestFormIndex: mostRelevantFormIndex,
            bestRelevanceScore: findMatchesResult.formRelevanceScores[mostRelevantFormIndex],
            bestFindMatchesResult: findMatchesResult
        };
    }

    // automated could be on page load or resulting from other non-user-interaction.
    // It's possible to fill and submit a entry with a specific uuid but
    // that process is now centered on the findMatches function. This function just
    // takes the results of that (which may include a specific entry to fill and submit to a specific form)
    fillAndSubmit(
        automated: boolean,
        formIndex?: number,
        entryIndex?: number,
        noSubmit = false
    ) {
        this.Logger.debug(
            "fillAndSubmit started. automated: " +
                automated +
                ", formIndex: " +
                formIndex +
                ", entryIndex: " +
                entryIndex
        );

        const matchResult = this.state.current;
        let submitTargetNeighbour;

        // Give up if we have no results for this frame (i.e. there were no forms to fill)
        if (!matchResult) return;

        // We do some things differently if we're being manually asked to fill and
        // submit a specific matched entry, and we pick the form to work on.
        const { isMatchedLoginRequest, mostRelevantFormIndex } = resolveFillTarget(
            {
                automated,
                formIndex,
                entryIndex,
                currentMostRelevantFormIndex: matchResult.mostRelevantFormIndex
            },
            () => this.getMostRelevantForm().bestFormIndex
        );
        matchResult.mostRelevantFormIndex = mostRelevantFormIndex;

        // from now on we concentrate on just the most relevant form and the fields we found earlier
        const form = matchResult.forms[matchResult.mostRelevantFormIndex];
        const passwordFields = matchResult.passwordFieldsArray[matchResult.mostRelevantFormIndex];
        const otherFields = matchResult.otherFieldsArray[matchResult.mostRelevantFormIndex];

        const orderedEntries = this.sortMatchedEntries(
            matchResult.entries[matchResult.mostRelevantFormIndex]
        );
        const orderedEntriesWithPreference = this.flagUserPreferredEntry(orderedEntries);

        if (
            shouldAnnounceEntries(
                isMatchedLoginRequest,
                matchResult.entries[matchResult.mostRelevantFormIndex]
            )
        ) {
            this.myPort.postMessage({
                entries: orderedEntriesWithPreference
            });

            // Give the user a way to choose an entry interactively
            this.keeFieldIcon.addKeeIconToFields(
                passwordFields,
                otherFields,
                orderedEntriesWithPreference
            );
        }

        // Decide auto vs. manual, the relevance threshold, multi-match preference
        // and per-entry overrides. decideFill is pure: it reports what to do and
        // logs to replay; we apply the results to matchResult here.
        const decision = decideFill({
            automated,
            isMatchedLoginRequest,
            entryIndex,
            entriesForForm: matchResult.entries[matchResult.mostRelevantFormIndex],
            orderedEntriesWithPreference,
            uuidHint: matchResult.UUID,
            autofillOnSuccess: matchResult.autofillOnSuccess,
            autosubmitOnSuccess: matchResult.autosubmitOnSuccess,
            config: this.config
        });
        decision.logs.forEach(l => this.Logger[l.level](l.message));

        // If we started this fill/submit attempt from certain contexts, we will have
        // been told to ensure we do not perform auto-fill or submit and we'll instead
        // just tell the UI to notify the user about any matches we found. Although
        // we ignore this rule if the user initiated the fill/submit.
        matchResult.cannotAutoFillForm = decision.cannotAutoFillForm;
        matchResult.cannotAutoSubmitForm = decision.cannotAutoSubmitForm;
        if (decision.clearUuid) {
            // A specific entry was selected by index, so clear any previously set
            // information about an auto-filled entry so it can be set correctly below.
            matchResult.UUID = null;
            matchResult.dbFileName = null;
        }

        // this records the entry that we eventually choose as the one to fill the chosen form with
        const matchingLogin = decision.matchingLogin;
        const action = decision.action;

        //TODO:5: #6 multi-page
        // // record / update the info attached to this tab regarding
        // // the number of pages of forms we want to fill in
        // // NB: we do this even if we know this is a single form
        // // submission becauase then if the user gets dumped
        // // back to the form (password error?) then we know not
        // // to auto-submit again (to avoid getting stuck in a loop)

        // if (tabState.currentPage > tabState.maximumPage)
        // {
        //     // I don't think this should ever happen because it's reset onFormSubmit
        //     // before this page has loaded.

        //     tabState.currentPage = 0;
        //     tabState.maximumPage = 0;
        //     tabState.forceAutoSubmit = null;
        //     matchResult.cannotAutoSubmitForm = true;
        //     this.Logger.info("Exceeded expected number of pages during this form-filling session. Not auto-submiting this form.");
        // }

        // // If the user manually requested this to be filled in or the current page is unknown
        // if (!automated)//TODO:5: #6 multi-page || tabState.currentPage <= 0)
        // {
        //     let maximumPageCount = 1;
        //     for (let i = 0; i < matchingLogin.passwords.length; i++)
        //     {
        //         const passField = matchingLogin.passwords[i];
        //         if (passField.formFieldPage > maximumPageCount)
        //             maximumPageCount = passField.formFieldPage;
        //     }
        //     for (let i = 0; i < matchingLogin.otherFields.length; i++)
        //     {
        //         const otherField = matchingLogin.otherFields[i];
        //         if (otherField.formFieldPage > maximumPageCount)
        //             maximumPageCount = otherField.formFieldPage;
        //     }
        //     //TODO:5: #6: multi-page
        //     // // always assume page 1 (very rare cases will go wrong - see github KeeFox #411 for relevant enhancement request)
        //     // // Possible regression since v1.4: We used to ignore currentPage entirely for the first
        //     // // page of a submission, now we might try to give preference to page 1 fields (though total
        //     // // relevance score shouldn't be shifted by enough to affect otherwise well-matched fields)
        //     // tabState.currentPage = 1;
        //     // tabState.maximumPage = maximumPageCount;
        //     // this.Logger.debug("currentPage is: " + tabState.currentPage);
        //     // this.Logger.debug("maximumPage is: " + tabState.maximumPage);
        // }

        if (matchingLogin != null && (action.fill || matchResult.mustAutoFillForm)) {
            this.Logger.debug("Going to auto-fill a form");

            const features = this.store.state.KeePassDatabases.find(
                db => db.fileName === matchingLogin.database.fileName
            ).sessionFeatures;
            const scoreConfig: FieldMatchScoreConfig = {
                punishWrongIDAndName:
                    features.indexOf("KPRPC_FIELD_DEFAULT_NAME_AND_ID_EMPTY") >= 0
            };
            const lastFilledOther = fillManyFormFields(
                otherFields,
                matchingLogin.fields.filter(f => f.type !== "password"),
                -1,
                scoreConfig,
                automated,
                this.fieldFillingDeps
            );
            const lastFilledPasswords = fillManyFormFields(
                passwordFields,
                matchingLogin.fields.filter(f => f.type === "password"),
                -1,
                scoreConfig,
                automated,
                this.fieldFillingDeps
            );
            matchResult.formReadyForSubmit = true;
            matchResult.lastFilledPasswords = lastFilledPasswords;
            matchResult.lastFilledOther = lastFilledOther;
            if (lastFilledPasswords && lastFilledPasswords.length > 0) {
                submitTargetNeighbour = lastFilledPasswords[0].DOMelement;
            } else if (lastFilledOther && lastFilledOther.length > 0) {
                submitTargetNeighbour = lastFilledOther[0].DOMelement;
            }
            this.formSaving.updateMatchResult(matchResult);
        }

        // We only do this if any forms were auto-filled successfully
        if (matchResult.formReadyForSubmit) {
            // if we didn't already define a uuid, we set it up now
            if (
                matchResult.UUID == undefined ||
                matchResult.UUID == null ||
                matchResult.UUID == ""
            ) {
                // TODO (T1): matchingLogin can be null here if formReadyForSubmit is
                // left over from an earlier fillAndSubmit call on the same matchResult
                // (it is only reset in initMatchResult / diagnoseFillForEntry), in
                // which case the next two lines throw. Preserved as-is.
                this.Logger.debug("Syncing UUID to: " + matchingLogin.uuid);
                matchResult.UUID = matchingLogin.uuid;
                matchResult.dbFileName = matchingLogin.database.fileName;
            }
        }

        // If this form fill is the non-final page of a multi-page login process we record the
        // UUID and dbFilename. We also enable auto-submit in some circumstances
        //TODO:5: #6: multi-page
        // if (matchResult.UUID != undefined && matchResult.UUID != null && matchResult.UUID != "")
        // {
        //     if (tabState.currentPage > 0 && tabState.currentPage < tabState.maximumPage)
        //     {
        //         if (matchResult.UUID)
        //         {
        //             this.Logger.debug("Setting UUID to: " + matchResult.UUID);
        //             tabState.UUID = matchResult.UUID;
        //         }
        //         if (matchResult.dbFileName)
        //         {
        //             this.Logger.debug("Setting dbFileName to: " + matchResult.dbFileName);
        //             tabState.dbFileName = matchResult.dbFileName;
        //         }

        //         // We force auto submit for all multi-page entries that have been triggered
        //         // by a one-click or matched login user selection, provided that operation
        //         // has not already been marked complete by the onFormSubmitHandler in formsSaveTab.js
        //         if (tabState.userRecentlyDemandedAutoSubmit)
        //         {
        //             tabState.forceAutoSubmit = true;
        //             this.Logger.debug("Set forceAutoSubmit to: true");
        //         }
        //     }
        // }

        if (
            !noSubmit &&
            !matchResult.cannotAutoSubmitForm &&
            (action.submit || matchResult.mustAutoSubmitForm) &&
            matchResult.formReadyForSubmit
        ) {
            this.Logger.info("Auto-submitting form...");
            submitForm(form, submitTargetNeighbour, this.submitButtonDeps, () =>
                this.formSaving.removeAllSubmitHandlers()
            );
        } else if (isMatchedLoginRequest) {
            this.Logger.debug("Matched entry request is not being auto-submitted.");
        } else {
            if (this.state.current.allMatchingLogins.length > 0) {
                if (automated) {
                    this.Logger.debug("Automatic form fill complete.");
                } else {
                    this.Logger.debug("Manual form fill complete.");
                }
            } else {
                this.Logger.info("Nothing to fill.");
            }
        }
    }

    sortMatchedEntries(entries: Entry[]): Entry[] {
        return entries
            .map(e => new Entry({ ...e }))
            .sort((a, b) => b.relevanceScore - a.relevanceScore);
    }

    flagUserPreferredEntry(orderedEntries: Entry[]): Entry[] {
        const url = new URL(window.document.URL);
        url.hostname = punycode.toUnicode(url.hostname);
        const conf = configManager.siteConfigFor(url.href);
        return orderedEntries.map(
            e =>
                new Entry({
                    ...e,
                    isPreferredMatch: conf.preferredEntryUuid === e.uuid ? true : false
                })
        );
    }

    public removeKeeIconFromAllFields() {
        this.keeFieldIcon.removeKeeIconFromAllFields();
    }
}
