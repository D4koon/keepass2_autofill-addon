// A large synthetic page for the benchmarks: lots of content that never holds
// a login (an app wrapper with thousands of rows, nav links, checkboxes), web
// components with nested open shadow roots, and a few forms, one of them a
// login whose email field lives in a web component (like auth.gmx.net).

export type BusyPageSize = {
    rows: number;
    links: number;
    components: number;
};

export const BUSY_PAGE: BusyPageSize = { rows: 3000, links: 200, components: 50 };

export function busyPageHtml(size: BusyPageSize = BUSY_PAGE): string {
    const links = Array.from({ length: size.links }, (_, i) => `<a href="/p${i}">Page ${i}</a>`);
    const rows = Array.from(
        { length: size.rows },
        (_, i) =>
            `<div class="row"><span>Item ${i}</span><input type="checkbox"><button>Open</button></div>`
    );
    const cards = Array.from({ length: size.components }, () => "<x-card></x-card>");
    return `
        <nav>${links.join("")}</nav>
        <form id="search" action="/search"><input type="search" name="q"></form>
        <div id="app">${rows.join("")}${cards.join("")}</div>
        <form id="login" action="/login">
            <x-text-field id="user" name="username"></x-text-field>
            <input type="password" id="pass" name="password">
            <button type="submit">Log in</button>
        </form>
        <form id="newsletter"><input type="email" name="newsletter"><button>Sign up</button></form>`;
}

// Fill in what HTML can't express: the open shadow roots
export function attachShadowRoots(doc: Document = document) {
    for (const card of Array.from(doc.querySelectorAll("x-card"))) {
        const sr = card.attachShadow({ mode: "open" });
        sr.innerHTML = "<div class=\"title\">Card</div><p>Text</p><x-badge></x-badge>";
        sr.querySelector("x-badge")!.attachShadow({ mode: "open" }).innerHTML = "<span>3</span>";
    }
    const field = doc.querySelector("x-text-field")!;
    field.attachShadow({ mode: "open" }).innerHTML =
        "<label for=\"email\">E-Mail</label><input type=\"email\" id=\"email\" name=\"email\">";
}

export function buildBusyPage(size: BusyPageSize = BUSY_PAGE) {
    document.body.innerHTML = busyPageHtml(size);
    attachShadowRoots();
}
