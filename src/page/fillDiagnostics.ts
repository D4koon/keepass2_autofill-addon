import { Entry } from "../common/model/Entry";
import { MatchResult } from "./MatchResult";
import { FrameMatchState } from "./frameMatchState";
import { FormUtils } from "./formsUtils";
import { KeeLogger } from "../common/Logger";
import type { FindMatchesBehaviour } from "./findMatchesBehaviour";

// The "why won't this entry fill here?" diagnosis, extracted verbatim from
// FormFilling. It drives the real scan + scoring + force-fill pipeline through a
// narrow host facade so it does not need to be a method on FormFilling.

export interface FillDiagnosisHost {
    logger: KeeLogger;
    formUtils: FormUtils;
    port: { postMessage(msg: unknown): void };
    state: FrameMatchState;
    findMatchesInThisFrame(behaviour: FindMatchesBehaviour): void;
    getRelevanceOfLoginMatchesAgainstAllForms(
        entries: Entry[],
        findLoginOp: any,
        matchResult: MatchResult
    ): unknown;
    getMostRelevantForm(formIndex?: number): {
        bestFormIndex: number;
        bestRelevanceScore: number;
        bestFindMatchesResult: unknown;
    };
    fillAndSubmit(
        automated: boolean,
        formIndex?: number,
        entryIndex?: number,
        noSubmit?: boolean
    ): void;
}

export function runFillDiagnosis(rawEntry: Entry, host: FillDiagnosisHost) {
    const report: string[] = [];
    const add = (line: string) => {
        report.push(line);
        host.logger.info("[diagnose-fill] " + line);
    };

    try {
        if (!rawEntry) {
            add("No entry data was supplied to the page.");
            return sendDiagnoseFillReport(report, host);
        }

        // Work on a plain, mutable clone: the entry arrives over the messaging
        // boundary and some of its properties are read-only on the model type.
        const entry: Entry = JSON.parse(JSON.stringify(rawEntry));

        add(`Entry: "${entry.title}"  (${entry.uuid})`);
        const entryFieldDesc = entry.fields
            .map(f => `${f.type}[${f.locators?.[0]?.name || f.locators?.[0]?.id || "no name/id"}]`)
            .join(", ");
        add(`Entry fields: ${entryFieldDesc || "(none)"}`);

        // Entries fetched by uuid (rather than by URL match) may not carry a
        // numeric match accuracy; without this the relevance maths becomes NaN.
        if (typeof entry.matchAccuracy !== "number" || !isFinite(entry.matchAccuracy)) {
            (entry as { matchAccuracy: number }).matchAccuracy = 0;
            add("Entry has no URL match accuracy (reached by search, not URL match); treating as 0.");
        }

        const hasUsername = !!Entry.getUsernameField(entry);
        const hasPassword = !!Entry.getPasswordField(entry);
        if (!hasUsername && !hasPassword) {
            add(
                "This entry has no username and no password field, so Kee can never fill " +
                    "it into a form. Add a username and/or password in KeePass."
            );
            return sendDiagnoseFillReport(report, host);
        }

        add(`Page URL: ${window.document.URL}`);
        const pageOrigin = window.location.origin;
        const entryCoversOrigin = (entry.URLs || []).some(u => {
            try {
                return new URL(u).origin === pageOrigin;
            } catch (e) {
                return false;
            }
        });
        if (entry.URLs && entry.URLs.length) {
            add(`Entry URL(s): ${entry.URLs.join(", ")}`);
            add(
                "Note: this entry was reached via text search, not URL matching. If the " +
                    "page URL is not covered by the entry URL(s) above (per the entry's match " +
                    "accuracy setting) it will never appear in the automatic matches list."
            );
        }
        if (!entryCoversOrigin) {
            add(
                `WARNING: none of this entry's URLs match the current origin (${pageOrigin}). ` +
                    "Diagnosis will still force-fill this form so you can see the result, but " +
                    "only do this on a site you trust - you would be typing these credentials " +
                    "into a page they do not belong to."
            );
        }

        // Make sure this frame has been scanned for forms at least once. We only
        // re-scan when there is no prior result at all - an existing result with no
        // login form is itself a useful finding, reported below.
        if (
            !host.state.current ||
            !host.state.current.forms ||
            host.state.current.forms.length === 0
        ) {
            add("Frame not scanned for forms yet - running form detection...");
            host.findMatchesInThisFrame({
                autofillOnSuccess: false,
                autosubmitOnSuccess: false
            });
        }

        const formCount =
            host.state.current && host.state.current.forms
                ? host.state.current.forms.length
                : 0;

        if (formCount === 0) {
            add(
                "No <form> and no loose input fields were found in this frame. There is " +
                    "nothing here for Kee to fill. If the login form is inside an iframe, " +
                    "run this diagnosis with that frame focused."
            );
            return sendDiagnoseFillReport(report, host);
        }

        const scannedIndexes: number[] =
            (host.state.loginOp && host.state.loginOp.formIndexes) || [];
        add(
            `Forms in this frame: ${formCount}; ` +
                `treated as login forms: ${scannedIndexes.length}`
        );

        // Kee only scores/fills forms it classified as login forms. Describe every
        // form so the user can see which one was skipped and roughly why.
        for (let i = 0; i < formCount; i++) {
            const f = host.state.current.forms[i] as HTMLFormElement;
            const label = f?.id || f?.name || "unnamed";
            if (scannedIndexes.indexOf(i) !== -1) {
                add(`  Form #${i} (${label}): treated as a login form.`);
                continue;
            }
            add(`  Form #${i} (${label}): NOT treated as a login form. ${describeForm(f, host)}`);
        }

        // Frame-wide picture - helps when the form Kee found is a red herring
        // and the real fields are elsewhere (shadow DOM, another iframe, loaded later).
        add(describeFrameFields(host));

        if (scannedIndexes.length === 0 || !host.state.loginOp.forms) {
            add(
                "Kee did not classify any form here as a login form, so it never searches " +
                    "for or fills entries on this page. Kee now also scans open shadow roots, " +
                    "so if fields still were not found the likely reasons are: a CLOSED " +
                    "shadow root (not scriptable at all), the real form is in another iframe, " +
                    "it loads after this check ran, or the field is type=text with a " +
                    "show/hide toggle. If it is a normal form, add it or a field to this " +
                    "site's white list in Settings > Finding forms."
            );
            return sendDiagnoseFillReport(report, host);
        }

        // Score this single entry against every scannable form, reusing the exact
        // production scoring path (which also emits its own per-field debug logging).
        // Mutates host.state.current in place (and returns it); no reassignment.
        host.getRelevanceOfLoginMatchesAgainstAllForms(
            [entry],
            host.state.loginOp,
            host.state.current
        );

        host.state.current.formRelevanceScores.forEach((score, i) => {
            if (scannedIndexes.indexOf(i) === -1) return;
            const f = host.state.current.forms[i] as HTMLFormElement;
            const scored = host.state.current.entries[i] && host.state.current.entries[i][0];
            add(
                `Form #${i} (${f?.id || f?.name || "unnamed"}): relevance ${round(score)}` +
                    (scored ? `, lowFieldMatchRatio=${!!scored.lowFieldMatchRatio}` : "")
            );
        });

        const best = host.getMostRelevantForm();
        add(
            `Best form: #${best.bestFormIndex} with score ${round(best.bestRelevanceScore)}. ` +
                "Automatic fill needs score >= 1 and lowFieldMatchRatio=false; below that the " +
                "entry is still offered in the list but not auto-filled."
        );

        // Force the fill of the best form regardless of the auto-fill threshold - this is
        // the "try it here anyway" part. We never submit from a diagnosis.
        add("Force-filling the best form now (ignoring the threshold, never submitting)...");
        host.state.current.UUID = null;
        host.state.current.dbFileName = null;
        host.state.current.formReadyForSubmit = false;
        host.state.current.mustAutoFillForm = true;
        host.state.current.mustAutoSubmitForm = false;
        host.fillAndSubmit(false, best.bestFormIndex, 0, true);

        const filled = [
            ...(host.state.current.lastFilledOther || []),
            ...(host.state.current.lastFilledPasswords || [])
        ];
        if (filled.length > 0) {
            const names = filled
                .map(
                    f =>
                        (f.DOMelement as HTMLInputElement)?.id ||
                        (f.DOMelement as HTMLInputElement)?.name ||
                        "unnamed"
                )
                .join(", ");
            add(`Filled ${filled.length} field(s): ${names}.`);
            add(
                "If the fields above are the wrong ones, the form/field detection is the " +
                    "problem. If nothing visibly changed, the fields may be hidden or " +
                    "re-rendered by the site's JavaScript."
            );
        } else {
            add(
                "No fields were filled. The per-field suitability scores are in the console " +
                    "at Debug log level (Settings > Logging). Common causes: the entry field " +
                    "names/ids do not resemble the form field names/ids, or the form fields " +
                    "are not visible."
            );
        }
    } catch (e) {
        add("Diagnosis stopped with an error: " + (e && e.message ? e.message : e));
    }

    sendDiagnoseFillReport(report, host);
}

function round(n: number) {
    return typeof n === "number" && isFinite(n) ? Math.round(n * 100) / 100 : n;
}

// Best-effort structural summary of a single form for the fill diagnosis.
function describeForm(f: any, host: FillDiagnosisHost): string {
    try {
        const els: any[] = f && f.elements ? Array.from(f.elements) : [];
        const tags: Record<string, number> = {};
        let passwords = 0;
        let visible = 0;
        for (const el of els) {
            const t = (el.localName + (el.type ? ":" + el.type : "")).toLowerCase();
            tags[t] = (tags[t] || 0) + 1;
            if ((el.type || "").toLowerCase() === "password") passwords++;
            try {
                if (host.formUtils.isDOMElementVisible(el)) visible++;
            } catch (e) {
                /* ignore */
            }
        }
        const tagSummary =
            Object.keys(tags)
                .map(k => `${k}×${tags[k]}`)
                .join(", ") || "none";
        const html = (f && f.outerHTML ? String(f.outerHTML) : "")
            .replace(/\s+/g, " ")
            .slice(0, 200);
        return (
            `form.elements: ${els.length} (${tagSummary}); ` +
            `password fields: ${passwords}; visible fields: ${visible}. ` +
            (html ? `HTML: ${html}${html.length === 200 ? "…" : ""}` : "")
        );
    } catch (e) {
        return "could not inspect this form (" + (e && e.message ? e.message : e) + ").";
    }
}

// Frame-wide field picture: catches the common cases where the form Kee found is
// not the real one - fields in shadow DOM, in a nested iframe, or added later.
function describeFrameFields(host: FillDiagnosisHost): string {
    try {
        const doc = window.document;
        const iframes = doc.getElementsByTagName("iframe").length;

        // Recurse through open shadow roots (Kee's own scanner does not) so we can
        // tell whether the real fields exist but are simply unreachable.
        let lightInputs = 0;
        let lightPw = 0;
        let shadowHosts = 0;
        let shadowInputs = 0;
        let shadowPw = 0;
        const hostChains: string[] = [];

        const label = (el: Element) => el.localName + (el.id ? "#" + el.id : "");

        const walk = (root: ParentNode, inShadow: boolean, chain: string) => {
            let nodes: Element[];
            try {
                nodes = Array.from(root.querySelectorAll("*"));
            } catch (e) {
                return;
            }
            for (const el of nodes) {
                if (el.localName === "input") {
                    const type = ((el as HTMLInputElement).type || "").toLowerCase();
                    if (inShadow) {
                        shadowInputs++;
                        if (type === "password") shadowPw++;
                    } else {
                        lightInputs++;
                        if (type === "password") lightPw++;
                    }
                }
                const sr = (el as { shadowRoot?: ShadowRoot }).shadowRoot;
                if (sr) {
                    shadowHosts++;
                    const nextChain = chain ? chain + " > " + label(el) : label(el);
                    const before = shadowInputs + shadowPw;
                    walk(sr, true, nextChain);
                    if (shadowInputs + shadowPw > before && hostChains.length < 5) {
                        hostChains.push(nextChain);
                    }
                }
            }
        };
        walk(doc, false, "");

        const totalPw = lightPw + shadowPw;
        let msg =
            `Frame totals: ${lightInputs} <input> and ${lightPw} password field(s) in the ` +
            `light DOM; ${shadowInputs} <input> and ${shadowPw} password field(s) inside ` +
            `${shadowHosts} open shadow root(s); ${iframes} nested iframe(s).`;

        if (shadowInputs > 0 && lightInputs === 0) {
            msg +=
                " The login fields are inside Shadow DOM (web components). Kee scans open " +
                "shadow roots, so these should be reachable; if they still were not picked " +
                "up they may be in a CLOSED shadow root or added after the scan.";
            if (hostChains.length) {
                msg += " Fields found under: " + hostChains.join("; ") + ".";
            }
        } else if (totalPw === 0 && iframes > 0) {
            msg +=
                " No password field in this frame but there are iframes - the login form " +
                "is probably inside one of them; open the diagnosis from that frame.";
        } else if (totalPw === 0) {
            msg +=
                " No password field anywhere in this frame yet - it may load after this " +
                "check ran, be a type=text field with a show/hide toggle, or be on a later " +
                "step of the login.";
        }
        return msg;
    } catch (e) {
        return "Frame totals: could not inspect (" + (e && e.message ? e.message : e) + ").";
    }
}

function sendDiagnoseFillReport(lines: string[], host: FillDiagnosisHost) {
    try {
        host.port.postMessage({ diagnoseFillReport: lines });
    } catch (e) {
        host.logger.warn("Could not send diagnose-fill report: " + e);
    }
}
