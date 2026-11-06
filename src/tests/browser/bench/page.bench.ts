// Benchmarks for the content script's hot paths on a large page, in real
// Chromium and Firefox. Not tests: they never fail, they measure. Run before
// and after a change to src/page/:
//
//   npm run bench -- --outputJson bench-before.json    (on the old code)
//   npm run bench -- --compare bench-before.json       (on the new code)
//
// Firefox rounds its clock to 1 ms (Chromium to 0.1 ms), so single samples of
// fast cases read 0 or 1; the mean over many samples is still meaningful.
import { bench, describe } from "vitest";
import { FormUtils } from "../../../page/formsUtils";
import { isStructural, MUTATION_OBSERVER_OPTIONS, wantsRescan } from "../../../page/rescanTrigger";
import { createHarness, makeEntry, type Harness } from "../../helpers/formFillingHarness";
import { attachShadowRoots, buildBusyPage, busyPageHtml } from "./busyPage";

const logger = { debug() {}, info() {}, warn() {}, error() {} };

const ENTRY = makeEntry([
    { type: "text", value: "me@example.com", name: "email" },
    { type: "password", value: "secret", name: "password" }
]);

// The mutation records `change` produces, as the page observer would get them
function recordsOf(change: () => void): MutationRecord[] {
    const observer = new MutationObserver(() => {});
    observer.observe(document.body, MUTATION_OBSERVER_OPTIONS);
    change();
    const records = observer.takeRecords();
    observer.disconnect();
    return records;
}

describe("form scan and matching", () => {
    let h: Harness;
    const setup = () => {
        h = createHarness(busyPageHtml());
        attachShadowRoots();
    };

    bench("full scan and match of the page", () => h.run([ENTRY]), { setup });

    bench(
        "rescan of an unchanged page",
        () => h.formFilling.findMatchesInThisFrame({}, true),
        {
            setup: () => {
                setup();
                h.run([ENTRY]);
            }
        }
    );
});

describe("shadow roots and form fields", () => {
    let u: FormUtils;
    const setup = () => {
        buildBusyPage();
        u = new FormUtils(logger as never);
    };

    bench(
        "list the page's open shadow roots (uncached)",
        () => {
            u.invalidateShadowCache();
            u.getOpenShadowRoots(document);
        },
        { setup }
    );

    bench(
        "fields of the login form, incl. web components",
        () => {
            u.getFormElements(document.getElementById("login"));
        },
        {
            setup: () => {
                setup();
                u.getOpenShadowRoots(document);
            }
        }
    );
});

describe("page observer: is this change worth a rescan?", () => {
    let u: FormUtils;
    let records: MutationRecord[];
    // As page.ts does it: a structural change drops the cached shadow roots first
    const check = () => {
        if (isStructural(records)) u.invalidateShadowCache();
        wantsRescan(records, u);
    };
    const setup = (change: () => void, freshCache = true) => () => {
        buildBusyPage();
        u = new FormUtils(logger as never);
        if (freshCache) u.getOpenShadowRoots(document);
        records = recordsOf(change);
    };

    bench("class toggle on the big app wrapper", check, {
        setup: setup(() => document.getElementById("app")!.classList.toggle("hover"))
    });

    bench("class toggles on 50 rows", check, {
        setup: setup(() => {
            const rows = document.querySelectorAll(".row");
            for (let i = 0; i < 50; i++) rows[i].classList.toggle("selected");
        })
    });

    bench("class change on <body>", check, {
        setup: setup(() => document.body.classList.toggle("scroll-lock"))
    });

    bench("20 rows of non-login controls re-rendered", check, {
        setup: setup(() => {
            const app = document.getElementById("app")!;
            for (let i = 0; i < 20; i++) {
                app.children[i].innerHTML =
                    `<span>Item ${i}</span><input type="range"><input type="checkbox"><button>Open</button>`;
            }
        })
    });

    bench("a web component with a login field added", check, {
        setup: setup(() => {
            const host = document.createElement("x-login");
            host.attachShadow({ mode: "open" }).innerHTML = "<input type=\"password\">";
            document.body.appendChild(host);
        })
    });
});
