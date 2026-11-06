// isFieldCoveredBySite in a real browser: it hit-tests, which jsdom can't
import { afterEach, describe, expect, it } from "vitest";
import { isFieldCoveredBySite } from "../../page/fieldCover";

function page(html: string, css = "") {
    document.head.querySelector("style#fixture")?.remove();
    const style = document.createElement("style");
    style.id = "fixture";
    style.textContent = `body { margin: 0; } input { width: 200px; height: 24px; } ${css}`;
    document.head.appendChild(style);
    document.body.innerHTML = html;
}
const input = (id: string) => document.getElementById(id) as HTMLInputElement;

afterEach(() => {
    document.body.innerHTML = "";
    document.head.querySelector("style#fixture")?.remove();
});

describe("isFieldCoveredBySite", () => {
    // Proxmox VE: the app is drawn behind the login window, under a mask
    it("sees a modal mask over the app's search box, but not over the login window", () => {
        page(
            `<div class="header"><input id="search" type="text"></div>
            <div class="mask"></div>
            <div class="window"><input id="user" type="text"></div>`,
            `.header { position: absolute; top: 10px; left: 10px; }
            .mask { position: fixed; inset: 0; background: rgba(0,0,0,.3); z-index: 10; }
            .window { position: absolute; top: 100px; left: 100px; z-index: 20; background: #fff; }`
        );
        expect(isFieldCoveredBySite(input("search"))).toBe(true);
        expect(isFieldCoveredBySite(input("user"))).toBe(false);
    });

    it("doesn't count the field's own floating label laid over it", () => {
        page(
            "<div class=\"wrap\"><input id=\"user\" type=\"text\"><label for=\"user\">E-mail</label></div>",
            `.wrap { position: relative; margin: 20px; }
            label { position: absolute; left: 4px; top: 0; width: 190px; height: 24px; }`
        );
        expect(isFieldCoveredBySite(input("user"))).toBe(false);
    });

    it("can't tell for a field outside the window, so doesn't call it covered", () => {
        page(
            "<input id=\"far\" type=\"text\"><div class=\"mask\"></div>",
            `#far { position: absolute; top: 5000px; }
            .mask { position: fixed; inset: 0; z-index: 10; }`
        );
        expect(isFieldCoveredBySite(input("far"))).toBe(false);
    });
});
