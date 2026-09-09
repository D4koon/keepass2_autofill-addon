import { FormUtils } from "./formsUtils";
import { KeeLogger } from "../common/Logger";

// Submit-button discovery and form submission, extracted verbatim from
// FormFilling. FormUtils and the logger are passed in via SubmitButtonDeps.
//
// The two "magic word" memo caches used to be instance fields on FormFilling,
// reset once per findMatchesInThisFrame. They are now local to each
// findSubmitButton call. This is behaviour-preserving: scoreAdjustmentForMagicWords
// memoises a deterministic predicate ("does this string contain one of the fixed
// good/bad words"), so cache lifetime only affects runtime, never the result.

export interface SubmitButtonDeps {
    formUtils: FormUtils;
    logger: KeeLogger;
}

class SubmitCandidate {
    distance: number;
    element: HTMLElement;
    score: number;
}

export function findSubmitButton(
    form: HTMLFormElement,
    submitTargetNeighbour: HTMLElement,
    deps: SubmitButtonDeps
) {
    const semanticWhitelistCache = {};
    const semanticBlacklistCache = {};
    const candidates: SubmitCandidate[] = [];
    const DISTANCE_MAX_SCORE = 100;
    const DISTANCE_DIFFERENCE_FACTOR = 20;
    const VISIBLE_SCORE = 60;
    const CAT_BUTTONINFORM_SCORE = 60;
    const CAT_SUBMITINPUTINFORM_SCORE = 50;
    const CAT_BUTTONOUTSIDEFORM_SCORE = 40;
    const CAT_IMAGEINPUTINFORM_SCORE = 40;
    const CAT_BUTTONINPUTINFORM_SCORE = 30;
    const CAT_BUTTONROLEINFORM_SCORE = 20;
    const CAT_BUTTONROLEOUTSIDEFORM_SCORE = 10;
    let minScoreToWin = 0;
    const distanceCalc = (v, t) => commonAncestorDistance(v, t, distanceMap);
    const distanceMap = new Map<Node, number>();
    const fUtils = deps.formUtils;

    function verifyPotentialCandidate(value: HTMLElement, score: number) {
        // abort early if we can't win even with a perfect visibility and distance score
        if (minScoreToWin > score + VISIBLE_SCORE + DISTANCE_MAX_SCORE) return;

        const isVisible = fUtils.isDOMElementVisible(value);

        // Some forms are hidden (e.g. Twitter) and simply revealed to the user at a later time
        // Therefore we should only punish based on visibility if the form submitTargetNeighbour is visible.
        if (isVisible || !fUtils.isDOMElementVisible(submitTargetNeighbour)) {
            score += VISIBLE_SCORE;
        }

        // abort early if we can't win even with a perfect visibility and distance score
        if (minScoreToWin > score + DISTANCE_MAX_SCORE) return;

        candidates.push({
            distance: distanceCalc(value, submitTargetNeighbour),
            element: value,
            score: score
        });

        minScoreToWin = score;
    }

    function resolveAriaLabelValues(element: HTMLElement) {
        const labels = [];
        if (element.hasAttribute("aria-label")) {
            labels.push(element.getAttribute("aria-label").toLowerCase());
        }
        element
            .getAttribute("aria-labelledby")
            ?.trim()
            .split(" ")
            .forEach(id => {
                if (id) {
                    const labelElement = form.ownerDocument.getElementById(id);
                    if (labelElement && labelElement.innerText) {
                        labels.push(labelElement.innerText.toLowerCase());
                    }
                }
            });

        return labels;
    }

    /*
        In Firefox Array.from...foreach is about 50% faster than the alternative in this comment below... but 20% slower in Chrome.
        const buttons = form.ownerDocument.getElementsByTagName("button");
        for (let i=0; i<buttons.length; i++) {
            const value = buttons[i];
            ...
        */
    // Native <button>s in the light DOM plus any inside open shadow roots
    // (web-component submit buttons such as Home Assistant's <ha-button>).
    const buttonEls = [
        ...Array.from(form.ownerDocument.getElementsByTagName("button"))
    ];
    try {
        const doc = (form.ownerDocument || document) as Document;
        for (const b of deps.formUtils.deepQueryAll<HTMLButtonElement>(doc, "button")) {
            if (buttonEls.indexOf(b) === -1) buttonEls.push(b);
        }
    } catch (e) {
        /* light-DOM buttons are enough */
    }
    buttonEls.forEach(value => {
        if (!value.isConnected) return;
        if (!value.type || value.type != "reset") {
            const semanticValues: string[] = [];
            if (value.name) semanticValues.push(value.name.toLowerCase());
            if (value.textContent) semanticValues.push(value.textContent.toLowerCase());
            if (value.value) semanticValues.push(value.value.toLowerCase());
            semanticValues.push(...resolveAriaLabelValues(value));

            let score = scoreAdjustmentForMagicWords(
                semanticValues,
                50,
                semanticWhitelistCache,
                semanticBlacklistCache
            );
            score +=
                value.form && value.form == form
                    ? CAT_BUTTONINFORM_SCORE
                    : CAT_BUTTONOUTSIDEFORM_SCORE;

            verifyPotentialCandidate(value, score);
        }
    });

    Array.from(form.getElementsByTagName("input")).forEach(value => {
        if (!value.isConnected) return;
        if (value.type != null) {
            let semanticScore = 0;

            if (value.type == "submit" || value.type == "button") {
                if (value.name) {
                    semanticScore += scoreAdjustmentForMagicWords(
                        [value.name.toLowerCase()],
                        50,
                        semanticWhitelistCache,
                        semanticBlacklistCache
                    );
                }

                // Names are more important but sometimes they don't exist or are random
                // so check what is actually displayed to the user
                const semanticValues = [];
                if (value.value) {
                    semanticValues.push(value.value.toLowerCase());
                }
                semanticValues.push(...resolveAriaLabelValues(value));
                if (semanticValues.length > 0) {
                    semanticScore += scoreAdjustmentForMagicWords(
                        semanticValues,
                        40,
                        semanticWhitelistCache,
                        semanticBlacklistCache
                    );
                }

                if (value.id) {
                    semanticScore += scoreAdjustmentForMagicWords(
                        [value.id.toLowerCase()],
                        20,
                        semanticWhitelistCache,
                        semanticBlacklistCache
                    );
                }
            }

            if (value.type == "submit" || value.type == "button" || value.type == "image") {
                let score = semanticScore;
                score +=
                    value.type == "button"
                        ? CAT_BUTTONINPUTINFORM_SCORE
                        : value.type == "image"
                        ? CAT_IMAGEINPUTINFORM_SCORE
                        : CAT_SUBMITINPUTINFORM_SCORE;
                verifyPotentialCandidate(value, score);
            }
        }
    });

    Array.from(form.ownerDocument.querySelectorAll("[role=button]:not(button)")).forEach(
        (value: any) => {
            if (!value.isConnected) return;
            const semanticValues: string[] = [];

            // technical
            if (value.name) semanticValues.push(value.name.toLowerCase());
            if (value.id) semanticValues.push(value.id.toLowerCase());

            // user visible
            if (value.title) semanticValues.push(value.title.toLowerCase());
            if (value.innerText) semanticValues.push(value.innerText.toLowerCase());
            if (value.dataSet && value.dataSet.length > 0) {
                if (value.dataSet.tooltip) {
                    semanticValues.push(value.dataSet.tooltip.toLowerCase());
                }
            }
            semanticValues.push(...resolveAriaLabelValues(value));

            let score = scoreAdjustmentForMagicWords(
                semanticValues,
                50,
                semanticWhitelistCache,
                semanticBlacklistCache
            );
            score +=
                value.form && value.form == form
                    ? CAT_BUTTONROLEINFORM_SCORE
                    : CAT_BUTTONROLEOUTSIDEFORM_SCORE;
            verifyPotentialCandidate(value, score);
        }
    );

    if (candidates.length <= 0) return null;
    if (candidates.length === 1) return candidates[0].element;

    const submitElements = candidates.sort((a, b) => {
        if (a.distance > b.distance) return -1;
        if (a.distance < b.distance) return 1;
        return 0;
    });

    const maxDistanceDifference =
        submitElements[0].distance - submitElements[submitElements.length - 1].distance;
    const distanceScore = Math.min(
        DISTANCE_MAX_SCORE,
        DISTANCE_DIFFERENCE_FACTOR * maxDistanceDifference
    );
    let distanceFactor = 1 / submitElements.length;
    let lastDistance = submitElements[0].distance;
    submitElements.forEach((candidate, index, elements) => {
        if (candidate.distance < lastDistance) {
            distanceFactor = (index + 1) / elements.length;
            lastDistance = candidate.distance;
        }
        candidate.score += distanceFactor * distanceScore;
    });

    //TODO:5: more accurate searching of submit buttons, etc. to avoid password resets if possible
    // maybe special cases for common HTML output patterns (e.g. javascript-only ASP.NET forms)

    let maxScore = submitElements[0].score;
    let maxScoreElement = submitElements[0].element;
    for (let i = 1; i < submitElements.length; i++) {
        if (submitElements[i].score > maxScore) {
            maxScore = submitElements[i].score;
            maxScoreElement = submitElements[i].element;
        }
    }
    return maxScoreElement;
}

function scoreAdjustmentForMagicWords(
    semanticValues: string[],
    factor: number,
    semanticWhitelistCache,
    semanticBlacklistCache
) {
    //TODO:5: other languages
    const goodWords = [
        "submit",
        "login",
        "enter",
        "log in",
        "signin",
        "sign in",
        "next",
        "continue"
    ];
    const badWords = [
        "reset",
        "cancel",
        "back",
        "abort",
        "undo",
        "exit",
        "empty",
        "clear",
        "captcha",
        "totp",
        "forgot",
        "dismiss",
        "delete",
        "show",
        "reveal"
    ];
    let goodScore = false;
    let badScore = false;

    for (let i = 0; i < semanticValues.length; i++) {
        if (goodScore) break;
        if (!semanticValues[i]) continue;
        const semanticValue = semanticValues[i].trim();
        if (!semanticValue) continue;

        if (semanticWhitelistCache[semanticValue] === true) {
            goodScore = true;
            break;
        }
        if (semanticWhitelistCache[semanticValue] === false) {
            continue;
        }
        for (let j = 0; j < goodWords.length; j++) {
            if (semanticValue.indexOf(goodWords[j]) >= 0) {
                goodScore = true;
                semanticWhitelistCache[semanticValue] = true;
                break;
            } else {
                semanticWhitelistCache[semanticValue] = false;
            }
        }
    }
    for (let i = 0; i < semanticValues.length; i++) {
        if (badScore) break;
        if (!semanticValues[i]) continue;
        const semanticValue = semanticValues[i].trim();
        if (!semanticValue) continue;

        if (semanticBlacklistCache[semanticValue] === true) {
            badScore = true;
            break;
        }
        if (semanticBlacklistCache[semanticValue] === false) {
            continue;
        }
        for (let j = 0; j < badWords.length; j++) {
            if (semanticValue.indexOf(badWords[j]) >= 0) {
                badScore = true;
                semanticBlacklistCache[semanticValue] = true;
                break;
            } else {
                semanticBlacklistCache[semanticValue] = false;
            }
        }
    }

    if (goodScore && badScore) return 0;
    if (badScore) return -1 * factor;
    if (goodScore) return factor;
    return 0;
}

function commonAncestorDistance(nodeA: Node, nodeB: Node, distanceMap: Map<Node, number>) {
    let distance = 1;
    let found = false;
    const pendingMap: Array<Node> = [];
    let pendingMapStartDistance = 0;

    // eslint-disable-next-line no-cond-assign
    while ((nodeA = nodeA.parentElement)) {
        const cachedNodeDistance = distanceMap.get(nodeA);

        // If we already know how far the parent is we can return early but we may have learnt about more nodes on our way
        if (cachedNodeDistance !== undefined) {
            distance += cachedNodeDistance;
            pendingMapStartDistance = cachedNodeDistance + 1;
            found = true;
            break;
        }

        // we know we don't know how far this node is so lets implicitly store how far we have got so far
        pendingMap.push(nodeA);

        if (nodeA.contains(nodeB)) {
            found = true;
            break;
        }
        distance++;
    }

    if (found) {
        // each node that we came across on our journey can be assigned a value of how far it is from the common parent
        if (pendingMap.length > 0) {
            for (let i = pendingMapStartDistance; i < distance && pendingMap.length > 0; i++) {
                const node = pendingMap.pop();
                distanceMap.set(node, i);
            }
        }
        return distance;
    } else {
        // Disconnected node (I guess - probably won't ever happen)
        return 9007199254740991;
    }
}

// Submit a form. onBeforeSubmit runs after the submit element has been located
// but before the click / form.submit() - FormFilling uses it to tear down its
// submit handlers so auto-submission doesn't trigger a "save password?" prompt.
export function submitForm(
    form: HTMLFormElement,
    submitTargetNeighbour: HTMLElement,
    deps: SubmitButtonDeps,
    onBeforeSubmit: () => void
) {
    const submitElement = findSubmitButton(form, submitTargetNeighbour, deps);

    // Avoid searching for matching passwords upon auto-submission
    onBeforeSubmit();

    // If we've found a button to click, use that; if not, just submit the form.
    if (submitElement != null) {
        deps.logger.debug(
            "Submiting using element: " + (submitElement as any).name + ": " + submitElement.id
        );
        submitElement.click();
    } else {
        deps.logger.debug("Submiting using form");
        form.submit();
    }

    //TODO:5: maybe something like this might be useful? Dunno why a click()
    // above wouldn't be sufficient but maybe some custom event raising might be handy...
    /*
    function simulateClick() {
    var evt = document.createEvent("MouseEvents");
    evt.initMouseEvent("click", true, true, window,
        0, 0, 0, 0, 0, false, false, false, false, 0, null);
    var cb = document.getElementById("checkbox");
    var canceled = !cb.dispatchEvent(evt);
    if(canceled) {
        // A handler called preventDefault
        alert("canceled");
    } else {
        // None of the handlers called preventDefault
        alert("not canceled");
    }
    }
    */
}
