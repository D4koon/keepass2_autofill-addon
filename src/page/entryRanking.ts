import { Entry } from "../common/model/Entry";
import { MatchResult } from "./MatchResult";
import { FormUtils } from "./formsUtils";
import { KeeLogger } from "../common/Logger";
import { configManager } from "../common/ConfigManager";
import punycode from "punycode/";
import {
    FieldMatchScoreConfig,
    ScoringDeps,
    calculateRelevanceScore
} from "./relevanceScoring";

// Entry ranking for the current frame, extracted verbatim from FormFilling:
// scoring every returned entry against every scanned form, sorting a form's
// matches by relevance, and flagging the site's preferred entry.

export interface EntryRankingDeps {
    logger: KeeLogger;
    formUtils: FormUtils;
    scoringDeps: ScoringDeps;
    // KPRPC session features for the database a given entry belongs to.
    sessionFeaturesFor(dbFileName: string): string[];
}

// Was FormFilling.getRelevanceOfLoginMatchesAgainstAllForms. Mutates matchResult
// in place and also returns it.
export function rankLoginMatchesAgainstAllForms(
    entries: Entry[],
    findLoginOp: any,
    matchResult: MatchResult,
    deps: EntryRankingDeps
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

        deps.logger.info("match found!");

        const formVisible = deps.formUtils.isDOMElementVisible(matchResult.submitTargets[i]);
        deps.logger.debug("formVisible: " + formVisible);

        const visibleFieldCache = {
            other: matchResult.otherFieldsArray[i].map(f =>
                deps.formUtils.isDOMElementVisible(f.DOMelement)
            ),
            password: matchResult.passwordFieldsArray[i].map(f =>
                deps.formUtils.isDOMElementVisible(f.DOMelement)
            )
        };

        // determine the relevance of each entry to this form
        // we could skip this when autofilling based on uuid but we would have to check for
        // matches first or else we risk no match and no alternative matching entries on the mainUI
        // and we also now consider the totality of possible matches against a field in order
        // to limit which fields we shove a Kee icon into.
        for (let v = 0; v < matchResult.entries[i].length; v++) {
            const features = deps.sessionFeaturesFor(
                matchResult.entries[i][v].database.fileName
            );
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
                deps.scoringDeps
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
                deps.logger.debug(
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

        deps.logger.debug(
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

export function sortMatchedEntries(entries: Entry[]): Entry[] {
    return entries
        .map(e => new Entry({ ...e }))
        .sort((a, b) => b.relevanceScore - a.relevanceScore);
}

export function flagUserPreferredEntry(orderedEntries: Entry[]): Entry[] {
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
