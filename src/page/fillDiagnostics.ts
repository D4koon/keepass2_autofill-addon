import { Entry } from "../common/model/Entry";
import { MatchResult } from "./MatchResult";
import { FrameMatchState } from "./frameMatchState";
import { FormUtils } from "./formsUtils";
import { KeeLogger } from "../common/Logger";
import type { FindMatchesBehaviour } from "./findMatchesBehaviour";
import { diag } from "../common/diagnosisReport";
import { MatchedField } from "./MatchedField";
import { isFieldCoveredBySite } from "./fieldCover";
import { RULES, findCandidates, pairFields } from "./fieldRanking";
import { MAX_EXTRA_FIELDS, describeBlocker } from "./formFit";
import { isOneTimeCodeField, isSwitchedOff, looksLikeSearchField } from "./fieldSignals";
import { Field } from "../common/model/Field";
import { configManager } from "../common/ConfigManager";
import { asksForTooMuchForFirstStep } from "./formScanner";
import punycode from "punycode/";

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
        if (entry.fields.some(f => !f.locators?.[0]?.name && !f.locators?.[0]?.id)) {
            add(
                diag.info(
                    "No name/id: the entry doesn't say which page field that value goes in, " +
                        "as usual for entries made in KeePass, so Kee picks the field."
                )
            );
        }
        if (entry.URLs && entry.URLs.length) {
            add(diag.kv("URLs", entry.URLs.join(", ")));
        }

        // Entries fetched by uuid (rather than by URL match) may not carry a
        // numeric match accuracy; without this the relevance maths becomes NaN.
        if (typeof entry.matchAccuracy !== "number" || !isFinite(entry.matchAccuracy)) {
            (entry as { matchAccuracy: number }).matchAccuracy = 0;
            add(
                diag.info(
                    "Looked up directly, so URL matching played no part in this check. The " +
                        "entry only appears in the automatic matches list if one of its URLs " +
                        "covers this page (per its match accuracy setting)."
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
                add(diag.ok(`${name}: treated as a login form: ${whyLoginForm(i, f, host)}.`));
                continue;
            }
            add(diag.warn(`${name}: NOT treated as a login form.`));
            add(...whyNotFirstStep(f, host));
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
                        "the username first) and none of its field names/ids are white-listed, " +
                        `or it is a <form> with no visible password field and more than ${1 + MAX_EXTRA_FIELDS} text fields to fill in.`
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

        host.state.current.formFits.forEach((_, i) => {
            if (scannedIndexes.indexOf(i) === -1) return;
            const f = host.state.current.forms[i] as HTMLFormElement;
            const fit = host.state.current.entries[i]?.[0]?.formFit;
            if (!fit) return;
            const loginField =
                fit.loginField === "password"
                    ? "a password field"
                    : fit.loginField === "username"
                      ? "a username field (first step of a two-step login)"
                      : "none";
            add(
                diag.kv(
                    `Form #${i} (${f?.id || f?.name || "unnamed"})`,
                    `login field: ${loginField}; stored field names matched: ${fit.storedMatches}`
                )
            );
            add(
                fit.blocker
                    ? diag.warn(`Not filled on its own: ${describeBlocker(fit.blocker)}.`)
                    : diag.ok("Can be filled on its own.")
            );
        });

        const best = host.getMostRelevantForm();
        add(diag.kv("Best form", `#${best.bestFormIndex}`));
        add(
            diag.info(
                "The best form has a visible password field, before one with a username field " +
                    "of a first step, before neither; then the most stored field names " +
                    "matched; then the first on the page. It is filled on its own unless it " +
                    "lacks a login field, looks like a sign-up form, or has more than " +
                    `${MAX_EXTRA_FIELDS} other text field the entry has nothing for, or has no ` +
                    "password field and only a generic field name such as email (an entry " +
                    "set to always auto-fill skips these checks). Otherwise the entry is only " +
                    "offered in the list."
            )
        );

        // Without a visible password field this may be no login at all, and a
        // diagnosis shouldn't type the username, or the password out of sight,
        // into a settings dialog
        const mayFill = host.state.current.formFits[best.bestFormIndex]?.loginField === "password";
        if (mayFill) {
            // Force the fill of the best form regardless of the auto-fill threshold - this is
            // the "try it here anyway" part. We never submit from a diagnosis.
            add(diag.info("Force-filled the best form (ignoring these checks, never submitting)."));
            host.state.current.UUID = null;
            host.state.current.dbFileName = null;
            host.state.current.formReadyForSubmit = false;
            host.state.current.mustAutoFillForm = true;
            host.state.current.mustAutoSubmitForm = false;
            host.fillAndSubmit(false, best.bestFormIndex, 0, true);
        } else {
            add(
                diag.info(
                    "Not filled: the best form has no visible password field, so it may not be a login. " +
                        "If it is, pick the entry in the popup to fill it."
                )
            );
        }

        const filled = mayFill
            ? [
                  ...(host.state.current.lastFilledOther || []),
                  ...(host.state.current.lastFilledPasswords || [])
              ]
            : [];
        add(...describeFilledForm(entry, best.bestFormIndex, filled, host));

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
        } else if (mayFill) {
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

function pageUrl() {
    const url = new URL(window.document.URL);
    url.hostname = punycode.toUnicode(url.hostname);
    return url.href;
}

// What made the scan take this form for a login form (formScanner.ts)
function whyLoginForm(i: number, f: HTMLFormElement, host: FillDiagnosisHost): string {
    const s = host.state.current;
    if (s.passwordFieldsArray?.[i]?.length > 0) return "it has a password field";

    const fields = (s.otherFieldsArray?.[i] || []).map(mf => mf.field);
    const url = pageUrl();
    const own = configManager.includeListMatch(f, configManager.ownSiteConfigFor(url), fields);
    if (own) return `this site's Include List names its ${own}`;
    if (fields.some(field => field.locators[0]?.autocompleteValues?.includes("username"))) {
        return "a field has autocomplete=\"username\"";
    }
    const all = configManager.includeListMatch(f, configManager.siteConfigFor(url), fields);
    return `the Include List for all websites names its ${all}`;
}

// Says so if the form was only turned down for asking too much of a first step
function whyNotFirstStep(f: any, host: FillDiagnosisHost): string[] {
    try {
        if (!(f instanceof HTMLFormElement)) return [];
        const { pwFields, otherFields } = host.formUtils.getFormFields(f, false, 50);
        const fields = otherFields.map(mf => mf.field);
        const conf = configManager.siteConfigFor(pageUrl());
        const interesting = configManager.isFormInteresting(f, conf, fields);
        // Excluded forms are turned down for that reason instead
        if (interesting === false) return [];
        const match = configManager.includeListMatch(f, conf, fields);
        // Without a password field, only the Include List gets a form this far
        if (pwFields.length === 0 && (!match || interesting !== true)) return [];
        if (!asksForTooMuchForFirstStep(pwFields, otherFields, host.formUtils)) return [];
        const opening =
            pwFields.length > 0
                ? "Its password field is hidden and it has"
                : `The Include List names its ${match}, but it has no password field and`;
        return [
            diag.bullet(
                `${opening} more than ${1 + MAX_EXTRA_FIELDS} text fields to fill in: too many ` +
                    "for the first step of a login."
            )
        ];
    } catch (e) {
        return [];
    }
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
            // Never pass on what is in the fields
            .replace(/\svalue\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
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

const MAX_FIELDS_LISTED = 30;

// Every field of the form that was filled: what it is and what was filled,
// then for each entry field which page field it went to and the rule that
// decided against the next best one. Names, ids and labels only - never values.
function describeFilledForm(
    entry: Entry,
    formIndex: number,
    filled: { DOMelement: HTMLInputElement | HTMLSelectElement }[],
    host: FillDiagnosisHost
): string[] {
    try {
        const s = host.state.current;
        const filledEls = new Set(filled.map(f => f.DOMelement));
        const usernameIndex = s.usernameIndexArray?.[formIndex];
        const deps = {
            isVisible: (el: HTMLElement) => host.formUtils.isDOMElementVisible(el),
            isCoveredBySite: isFieldCoveredBySite
        };
        const groups = [
            {
                formFields: s.otherFieldsArray?.[formIndex] || [],
                dataFields: entry.fields.filter(f => f.type !== "password"),
                usernameIndex
            },
            {
                formFields: s.passwordFieldsArray?.[formIndex] || [],
                dataFields: entry.fields.filter(f => f.type === "password"),
                usernameIndex: undefined
            }
        ];

        const lines = [diag.heading(`Fields of form #${formIndex}`)];
        // Report numbers run across both groups: #n
        const numbers = new Map<MatchedField, number>();
        let n = 0;
        for (const g of groups) {
            g.formFields.forEach((mf, i) => {
                if (!mf) return;
                numbers.set(mf, n);
                if (n < MAX_FIELDS_LISTED) {
                    const parts = [describeField(mf, host)];
                    if (i === g.usernameIndex) parts.push("guessed username field");
                    parts.push(filledEls.has(mf.DOMelement) ? "FILLED" : "not filled");
                    lines.push(diag.bullet(`#${n} ` + parts.join("; ")));
                }
                n++;
            });
        }
        if (n > MAX_FIELDS_LISTED) {
            lines.push(diag.info(`${n - MAX_FIELDS_LISTED} more field(s) not listed.`));
        }
        if (n === 0) lines.push(diag.info("The form has no fields Kee could fill."));

        lines.push(diag.heading("How the fields were chosen"));
        for (const g of groups) {
            const picks = pairFields(findCandidates(g.formFields, g.dataFields, g.usernameIndex, deps));
            const placed = new Set<number>();
            for (const { winner, runnerUp, rule } of picks) {
                placed.add(winner.dataFieldIndex);
                const to = `#${numbers.get(g.formFields[winner.formFieldIndex])}`;
                const why = runnerUp
                    ? `beat #${numbers.get(g.formFields[runnerUp.formFieldIndex])} at rule ${rule + 1}: ${RULES[rule].says}`
                    : "the only page field left that fits";
                lines.push(
                    diag.bullet(`${entryFieldName(g.dataFields[winner.dataFieldIndex])} → ${to}: ${why}`)
                );
            }
            g.dataFields.forEach((d, j) => {
                if (!placed.has(j)) {
                    lines.push(
                        diag.bullet(`${entryFieldName(d)} → nothing: no page field left of type ${d.type}`)
                    );
                }
            });
        }
        lines.push(
            diag.info(
                "Each entry field goes to a page field of the same type. Two candidates are " +
                    "compared rule by rule, and the first rule that tells them apart decides: " +
                    RULES.map((r, i) => `${i + 1}. ${r.says}`).join("; ") +
                    "."
            )
        );
        return lines;
    } catch (e) {
        return [
            diag.warn(
                "Could not list the form's fields (" + (e && e.message ? e.message : e) + ")."
            )
        ];
    }
}

function describeField(mf: MatchedField, host: FillDiagnosisHost): string {
    const el = mf.DOMelement as HTMLInputElement;
    const locator = mf.field?.locators?.[0];
    const quote = (v: string) => `"${v.length > 40 ? v.slice(0, 40) + "…" : v}"`;
    const parts = [(el.type || locator?.type || el.localName || "?").toLowerCase()];
    if (el.name) parts.push("name=" + quote(el.name));
    if (el.id) parts.push("id=" + quote(el.id));
    const label = locator?.labels?.[0];
    if (label) parts.push("label=" + quote(label));
    if (el.autocomplete) parts.push("autocomplete=" + quote(el.autocomplete));
    let visible: boolean | undefined;
    try {
        visible = host.formUtils.isDOMElementVisible(el);
    } catch {
        visible = undefined;
    }
    parts.push(visible === undefined ? "visibility unknown" : visible ? "visible" : "hidden");
    if (el.readOnly) parts.push("read-only");
    if (el.disabled) parts.push("disabled");
    if (isFieldCoveredBySite(el)) parts.push("covered by something else on the page");
    if (isSwitchedOff(el)) parts.push("switched off by the site (inert/aria-hidden)");
    if (looksLikeSearchField(el, locator?.labels)) parts.push("looks like a search box");
    if (isOneTimeCodeField(el)) parts.push("one-time code field");
    if (el.getRootNode() instanceof ShadowRoot) parts.push("in shadow DOM");
    return parts.join(" ");
}

function entryFieldName(f: Field): string {
    return `"${f.name || f.locators?.[0]?.name || f.locators?.[0]?.id || f.type}"`;
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
