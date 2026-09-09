import { MatchResult } from "./MatchResult";
import type { FindMatchesBehaviour } from "./findMatchesBehaviour";

// Owns the per-frame match state that used to be two loose fields on FormFilling:
//
//  - `current`: the MatchResult that accumulates a scan's forms, fields and
//    scored entries. It is created once and never reassigned - only mutated in
//    place - so formSaving can keep a live reference to it (it reads
//    lastFilledPasswords / lastFilledOther off it after a fill).
//  - `loginOp`: a loose bag describing which forms the in-flight KPRPC search
//    covers (forms / formIndexes, plus a vestigial back-reference).
export class FrameMatchState {
    public readonly current: MatchResult = new MatchResult();

    public loginOp: any = {};

    // Was FormFilling.initMatchResult. Resets `current` in place for a new scan.
    //
    // TODO: this deliberately does NOT clear `loginOp` - initMatchResult never
    // did. A rescan that finds no forms can therefore leave a stale
    // `loginOp.forms` / `loginOp.formIndexes` around, which
    // getRelevanceOfLoginMatchesAgainstAllForms would then iterate. Preserved
    // as-is; not fixed here.
    public reset(behaviour: FindMatchesBehaviour) {
        //TODO:5: #6 create new object might cause issues with multi-page or submit behaviour? if not, this would be neater:
        // this.current = new MatchResult();
        this.current.UUID = "";
        this.current.entries = [];
        this.current.mostRelevantFormIndex = null;

        this.current.mustAutoFillForm = false;
        this.current.cannotAutoFillForm = false;
        this.current.mustAutoSubmitForm = false;
        this.current.cannotAutoSubmitForm = false;

        if (behaviour.UUID != undefined && behaviour.UUID != null && behaviour.UUID != "") {
            // Keep a record of the specific entry we are going to search for (we delete
            // the tabstate below and re-create it during form fill)
            this.current.UUID = behaviour.UUID;
            this.current.dbFileName = behaviour.dbFileName;

            // we want to fill the form with this data
            this.current.mustAutoFillForm = true;

            if (behaviour.mustAutoSubmitForm) this.current.mustAutoSubmitForm = true;
        }

        this.current.doc = window.document;

        this.current.formReadyForSubmit = false; // tracks whether we actually auto-fill on this page
        this.current.autofillOnSuccess = behaviour.autofillOnSuccess;
        this.current.autosubmitOnSuccess = behaviour.autosubmitOnSuccess;
        this.current.notifyUserOnSuccess = behaviour.notifyUserOnSuccess;
        this.current.wrappers = [];
        this.current.allMatchingLogins = [];
        this.current.formRelevanceScores = [];
        this.current.submitTargets = [];
        this.current.usernameIndexArray = [];
        this.current.passwordFieldsArray = [];
        this.current.otherFieldsArray = [];
        this.current.requestCount = 0;
        this.current.responseCount = 0;
        this.current.requestIds = []; // the JSONRPC request Ids that reference this matchResult object (to allow deletion after async callback processing)
    }
}
