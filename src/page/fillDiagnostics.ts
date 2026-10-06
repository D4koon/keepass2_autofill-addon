import { Entry } from "../common/model/Entry";
import { MatchResult } from "./MatchResult";
import { FrameMatchState } from "./frameMatchState";
import { FormUtils } from "./formsUtils";
import { KeeLogger } from "../common/Logger";
import type { FindMatchesBehaviour } from "./findMatchesBehaviour";
import { diag } from "../common/diagnosisReport";

// The "why won't this entry fill here?" diagnosis, extracted verbatim from
// FormFilling. It drives the real scan + scoring + force-fill pipeline through a
// narrow host facade so it does not need to be a method on FormFilling.
// Report lines use the markup in common/diagnosisReport so the popup can render
// them as a structured card.

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
    const add = (...lines: string[]) => {
        for (const line of lines) {
            report.push(line);
            host.logger.info("[diagnose-fill] " + line);
        }
    };

    try {
        if (!rawEntry) {
            add(diag.error("No entry data was supplied to the page."));
            return sendDiagnoseFillReport(report, host);
        }

        // Work on a plain, mutable clone: the entry arrives over the messaging
        // boundary and some of its properties are read-only on the model type.
        const entry: Entry = JSON.parse(JSON.stringify(rawEntry));

        add(diag.heading("Entry"));
        add(diag.kv("Title", entry.title), diag.kv("UUID", entry.uuid));
        const entryFieldDesc = entry.fields
            .map(
                f => `${f.type} (${f.locators?.[0]?.name || f.locators?.[0]?.id || "no name/id"})`
            )
            .join(", ");
        add(diag.kv("Fields", entryFieldDesc || "(none)"));
        if (entry.URLs && entry.URLs.length) {
            add(diag.kv("URLs", entry.URLs.join(", ")));
        }

        // Entries fetched by uuid (rather than by URL match) may not carry a
        // numeric match accuracy; without this the relevance maths becomes NaN.
        if (typeof entry.matchAccuracy !== "number" || !isFinite(entry.matchAccuracy)) {
            (entry as { matchAccuracy: number }).matchAccuracy = 0;
            add(
                diag.info(
                    "Reached via search, not URL matching. It only appears in the automatic " +
                        "matches list if one of its URLs covers this page (per its match " +
                        "accuracy setting)."
                )
            );
        }

        const hasUsername = !!Entry.getUsernameField(entry);
        const hasPassword = !!Entry.getPasswordField(entry);
        if (!hasUsername && !hasPassword) {
            add(
                diag.error(
                    "This entry has no username and no password field, so Kee can never " +
                        "fill it into a form. Add a username and/or password in KeePass."
                )
            );
            return sendDiagnoseFillReport(report, host);
        }

        add(diag.heading("Page"));
        add(diag.kv("URL", window.document.URL));
        const pageOrigin = window.location.origin;
        const entryCoversOrigin = (entry.URLs || []).some(u => {
            try {
                return new URL(u).origin === pageOrigin;
            } catch (e) {
                return false;
            }
        });
        if (entryCoversOrigin) {
            add(diag.ok(`An entry URL matches this origin (${pageOrigin}).`));
        } else {
            add(
                diag.warn(
                    `None of this entry's URLs match the current origin (${pageOrigin}). ` +
                        "Diagnosis will still force-fill this form so you can see the result, " +
                        "but only do this on a site you trust - you would be typing these " +
                        "credentials into a page they do not belong to."
                )
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
            add(diag.info("Frame had not been scanned for forms yet - ran form detection now."));
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
            add(diag.heading("Result"));
            add(
                diag.error(
                    "No <form> and no loose input fields were found in this frame. There " +
                        "is nothing here for Kee to fill. If the login form is inside an " +
                        "iframe, run this diagnosis with that frame focused."
                )
            );
            return sendDiagnoseFillReport(report, host);
        }

        const scannedIndexes: number[] =
            (host.state.loginOp && host.state.loginOp.formIndexes) || [];

        add(diag.heading("Forms"));
        add(
            diag.kv("Forms found", formCount),
            diag.kv("Treated as login forms", scannedIndexes.length)
        );

        // Kee only scores/fills forms it classified as login forms. Describe every
        // form so the user can see which one was skipped and roughly why.
        for (let i = 0; i < formCount; i++) {
            const f = host.state.current.forms[i] as HTMLFormElement;
            const name = `Form #${i} (${f?.id || f?.name || "unnamed"})`;
            if (scannedIndexes.indexOf(i) !== -1) {
                add(diag.ok(`${name}: treated as a login form.`));
                continue;
            }
            add(diag.warn(`${name}: NOT treated as a login form.`));
            add(...describeForm(f, host));
        }

        // Frame-wide picture - helps when the form Kee found is a red herring
        // and the real fields are elsewhere (shadow DOM, another iframe, loaded later).
        add(...describeFrameFields());

        add(diag.heading("Result"));
        if (scannedIndexes.length === 0 || !host.state.loginOp.forms) {
            add(
                diag.error(
                    "Kee did not classify any form here as a login form, so it never " +
                        "searches for or fills entries on this page."
                ),
                "Likely reasons:",
                diag.bullet(
                    "The form has no password field (e.g. a two-step login that asks for " +
                        "the username first) and none of its field names/ids are white-listed."
                ),
                diag.bullet("The real form is in another iframe."),
                diag.bullet("The form loads after this check ran."),
                diag.bullet("The fields are in a CLOSED shadow root (not scriptable at all)."),
                diag.bullet("The password field is type=text with a show/hide toggle."),
                diag.info(
                    "If it is a normal form, add it or a field to this site's white list " +
                        "in Settings > Finding forms."
                )
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
                diag.kv(
                    `Form #${i} (${f?.id || f?.name || "unnamed"})`,
                    `relevance ${round(score)}` +
                        (scored ? `, lowFieldMatchRatio=${!!scored.lowFieldMatchRatio}` : "")
                )
            );
        });

        const best = host.getMostRelevantForm();
        add(
            diag.kv("Best form", `#${best.bestFormIndex} (score ${round(best.bestRelevanceScore)})`)
        );
        add(
            (best.bestRelevanceScore >= 1 ? diag.ok : diag.warn)(
                "Automatic fill needs score >= 1 and lowFieldMatchRatio=false; below that the " +
                    "entry is still offered in the list but not auto-filled."
            )
        );

        // Force the fill of the best form regardless of the auto-fill threshold - this is
        // the "try it here anyway" part. We never submit from a diagnosis.
        add(diag.info("Force-filled the best form (ignoring the threshold, never submitting)."));
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
            add(diag.ok(`Filled ${filled.length} field(s): ${names}.`));
            add(
                diag.info(
                    "If these are the wrong fields, the form/field detection is the problem. " +
                        "If nothing visibly changed, the fields may be hidden or re-rendered " +
                        "by the site's JavaScript."
                )
            );
        } else {
            add(
                diag.error("No fields were filled."),
                "Common causes:",
                diag.bullet("The entry field names/ids do not resemble the form field names/ids."),
                diag.bullet("The form fields are not visible."),
                diag.info(
                    "The per-field suitability scores are in the console at Debug log " +
                        "level (Settings > Logging)."
                )
            );
        }
    } catch (e) {
        add(diag.error("Diagnosis stopped with an error: " + (e && e.message ? e.message : e)));
    }

    sendDiagnoseFillReport(report, host);
}

function round(n: number) {
    return typeof n === "number" && isFinite(n) ? Math.round(n * 100) / 100 : n;
}

// Best-effort structural summary of a single form for the fill diagnosis.
function describeForm(f: any, host: FillDiagnosisHost): string[] {
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
            .slice(0, 300);
        const lines = [
            diag.bullet(`Elements: ${els.length} (${tagSummary})`),
            diag.bullet(`Password fields: ${passwords}; visible fields: ${visible}`)
        ];
        if (html) lines.push(diag.code(html + (html.length === 300 ? "…" : "")));
        return lines;
    } catch (e) {
        return [
            diag.bullet(
                "Could not inspect this form (" + (e && e.message ? e.message : e) + ")."
            )
        ];
    }
}

// Frame-wide field picture: catches the common cases where the form Kee found is
// not the real one - fields in shadow DOM, in a nested iframe, or added later.
function describeFrameFields(): string[] {
    try {
        const doc = window.document;
        const iframes = doc.getElementsByTagName("iframe").length;

        // Recurse through open shadow roots so we can tell whether the real
        // fields exist but are simply unreachable.
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
        const lines = [
            diag.kv("Inputs in page", `${lightInputs} (${lightPw} password)`),
            diag.kv(
                "Inputs in shadow DOM",
                `${shadowInputs} (${shadowPw} password) in ${shadowHosts} open shadow root(s)`
            ),
            diag.kv("Nested iframes", iframes)
        ];

        if (shadowInputs > 0 && lightInputs === 0) {
            lines.push(
                diag.info(
                    "The login fields are inside Shadow DOM (web components). Kee scans open " +
                        "shadow roots, so these should be reachable; if they still were not " +
                        "picked up they may be in a CLOSED shadow root or added after the scan." +
                        (hostChains.length ? " Fields found under: " + hostChains.join("; ") + "." : "")
                )
            );
        } else if (totalPw === 0 && iframes > 0) {
            lines.push(
                diag.info(
                    "No password field in this frame but there are iframes - the password " +
                        "may be inside one of them (see the other frames' reports), or on a " +
                        "later step of the login."
                )
            );
        } else if (totalPw === 0) {
            lines.push(
                diag.info(
                    "No password field anywhere in this frame yet - it may load after this " +
                        "check ran, be a type=text field with a show/hide toggle, or be on a " +
                        "later step of the login."
                )
            );
        }
        return lines;
    } catch (e) {
        return [
            diag.warn(
                "Could not inspect the frame's fields (" + (e && e.message ? e.message : e) + ")."
            )
        ];
    }
}

function sendDiagnoseFillReport(lines: string[], host: FillDiagnosisHost) {
    try {
        host.port.postMessage({ diagnoseFillReport: lines });
    } catch (e) {
        host.logger.warn("Could not send diagnose-fill report: " + e);
    }
}
