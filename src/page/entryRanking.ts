import { Entry } from "../common/model/Entry";
import { MatchResult } from "./MatchResult";
import { FormUtils } from "./formsUtils";
import { KeeLogger } from "../common/Logger";
import { configManager } from "../common/ConfigManager";
import punycode from "punycode/";
import { FormFacts, assessFit, compareEntries, compareForms } from "./formFit";

// How each returned entry fits each scanned form (formFit.ts), the best form
// for each entry, and the order entries are offered in.

export interface EntryRankingDeps {
    logger: KeeLogger;
    formUtils: FormUtils;
    // Whether something else on the page lies over the field (see fieldCover.ts)
    isCoveredBySite(element: HTMLElement): boolean;
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

    for (let i = 0; i < findLoginOp.forms.length; i++) {
        // Skip any form that we don't want to match against this set of entries
        if (findLoginOp.formIndexes.indexOf(i) == -1) continue;

        // Each form gets its own copies of the entries, as the fit differs per form
        matchResult.entries[i] = JSON.parse(crString);
        if (matchResult.entries[i].length == 0) continue;

        const siteVouches = () => {
            const url = new URL(window.document.URL);
            url.hostname = punycode.toUnicode(url.hostname);
            return configManager.siteVouchesForForm(
                findLoginOp.forms[i],
                url.href,
                matchResult.otherFieldsArray[i].map(f => f.field)
            );
        };

        const form = new FormFacts(
            matchResult.passwordFieldsArray[i],
            matchResult.otherFieldsArray[i],
            matchResult.usernameIndexArray?.[i],
            {
                isVisible: el => deps.formUtils.isDOMElementVisible(el),
                isCoveredBySite: el => deps.isCoveredBySite(el)
            },
            // Only a form without a password field needs to know
            !matchResult.passwordFieldsArray[i]?.length && siteVouches()
        );

        matchResult.entries[i].forEach((entry, v) => {
            entry.formFit = assessFit(entry, form);
            // Kept on the entry, so the same entry is found again when the
            // user picks it in the popup
            entry.formIndex = i;
            entry.entryIndex = v;

            // The best form for each entry; on a tie the one that comes first
            const best = matchResult.allMatchingLogins[v];
            if (!best || compareForms(entry.formFit, best.formFit) > 0) {
                matchResult.allMatchingLogins[v] = entry;
            }
        });

        // How the form does with its best-fitting entry, for choosing the form
        matchResult.formFits[i] = matchResult.entries[i]
            .map(e => e.formFit)
            .reduce((top, fit) => (compareForms(fit, top) > 0 ? fit : top));
        deps.logger.debug(
            `Form ${i} (${findLoginOp.forms[i].id}): ${JSON.stringify(matchResult.formFits[i])}`
        );
    }
    return matchResult;
}

export function sortMatchedEntries(entries: Entry[]): Entry[] {
    return entries.map(e => new Entry({ ...e })).sort(compareEntries);
}

// The form to fill: the first rule in compareForms that differs decides, and
// on a tie the one that comes first on the page
export function bestFormIndex(matchResult: MatchResult): number {
    let best = 0;
    matchResult.formFits.forEach((fit, i) => {
        if (fit && (!matchResult.formFits[best] || compareForms(fit, matchResult.formFits[best]) > 0)) {
            best = i;
        }
    });
    return best;
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
