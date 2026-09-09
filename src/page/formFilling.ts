import { PanelStub } from "./PanelStub";
import { MatchedLoginsPanel } from "./matchedLoginsPanel";
import { FormUtils } from "./formsUtils";
import { FormSaving } from "./formSaving";
import { KeeFieldIcon } from "./keeFieldIcon";
import { FieldMatchScoreConfig, ScoringDeps } from "./relevanceScoring";
import {
    EntryRankingDeps,
    flagUserPreferredEntry,
    rankLoginMatchesAgainstAllForms,
    sortMatchedEntries
} from "./entryRanking";
import { FormScannerDeps, scanFrameForForms } from "./formScanner";
import { SubmitButtonDeps, submitForm } from "./submitButtonFinder";
import { FieldFillingDeps, fillManyFormFields } from "./fieldFilling";
import { decideFill, resolveFillTarget, shouldAnnounceEntries } from "./fillDecision";
import { FrameMatchState } from "./frameMatchState";
import { runFillDiagnosis } from "./fillDiagnostics";
import type { FindMatchesBehaviour } from "./findMatchesBehaviour";
import { KeeLogger } from "../common/Logger";
import { Config } from "../common/config";
import { Entry } from "../common/model/Entry";
import NonReactiveStore from "../store/NonReactiveStore";

export class FormFilling {
    private state = new FrameMatchState();
    private keeFieldIcon: KeeFieldIcon;
    private panel: MatchedLoginsPanel;

    // Kept for API parity; nothing outside this class reads it.
    public get matchedLoginsPanelStub(): PanelStub {
        return this.panel.stubInstance;
    }

    // Debounced rescan timer set by the page's DOM mutation observer via
    // scheduleRescan(); read through isRescanPending(). findMatchesInThisFrame
    // cancels it on entry.
    private formFinderTimer: number = null;

    private scoringDeps: ScoringDeps;
    private submitButtonDeps: SubmitButtonDeps;
    private fieldFillingDeps: FieldFillingDeps;
    private entryRankingDeps: EntryRankingDeps;
    private formScannerDeps: FormScannerDeps;

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
        this.entryRankingDeps = {
            logger: this.Logger,
            formUtils: this.formUtils,
            scoringDeps: this.scoringDeps,
            sessionFeaturesFor: dbFileName =>
                this.store.state.KeePassDatabases.find(db => db.fileName === dbFileName)
                    .sessionFeatures
        };
        this.formScannerDeps = {
            logger: this.Logger,
            formUtils: this.formUtils,
            state: this.state,
            matchFinder: this.matchFinder,
            submitButtonDeps: this.submitButtonDeps,
            formSaving: this.formSaving
        };
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

    // Has the DOM mutation observer already queued a rescan of this frame?
    public isRescanPending(): boolean {
        return this.formFinderTimer !== null;
    }

    // Queue a debounced rescan of this frame (called by the page's mutation observer).
    public scheduleRescan(delayMs: number) {
        this.formFinderTimer = window.setTimeout(() => this.findMatchesInThisFrame(), delayMs);
    }

    private cancelScheduledRescan() {
        if (this.formFinderTimer !== null) {
            clearTimeout(this.formFinderTimer);
            this.formFinderTimer = null;
        }
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
        this.cancelScheduledRescan();
        scanFrameForForms(behaviour, this.formScannerDeps);
    }

    public findLoginsResultHandler(entries: Entry[]) {
        if (!entries) return;
        const validEntries = entries.filter(
            e => Entry.getUsernameField(e) || Entry.getPasswordField(e)
        );

        // Mutates this.state.current in place (and returns it); no reassignment.
        rankLoginMatchesAgainstAllForms(
            validEntries,
            this.state.loginOp,
            this.state.current,
            this.entryRankingDeps
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
                rankLoginMatchesAgainstAllForms(
                    entries,
                    findLoginOp,
                    matchResult,
                    this.entryRankingDeps
                ),
            getMostRelevantForm: formIndex => this.getMostRelevantForm(formIndex),
            fillAndSubmit: (automated, formIndex, entryIndex, noSubmit) =>
                this.fillAndSubmit(automated, formIndex, entryIndex, noSubmit)
        });
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

        const orderedEntries = sortMatchedEntries(
            matchResult.entries[matchResult.mostRelevantFormIndex]
        );
        const orderedEntriesWithPreference = flagUserPreferredEntry(orderedEntries);

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
                scoreConfig,
                automated,
                this.fieldFillingDeps
            );
            const lastFilledPasswords = fillManyFormFields(
                passwordFields,
                matchingLogin.fields.filter(f => f.type === "password"),
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

    public removeKeeIconFromAllFields() {
        this.keeFieldIcon.removeKeeIconFromAllFields();
    }
}
