// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { isSwitchedOff, looksLikeSearchField, stepsToMeet } from "../page/fieldSignals";

afterEach(() => {
    document.body.innerHTML = "";
});
const el = (id: string, root: ParentNode = document) =>
    root.querySelector<HTMLInputElement>("#" + id);

describe("looksLikeSearchField", () => {
    it.each([
        ['<input id="f" type="search">', "type=search"],
        ['<input id="f" role="searchbox">', "role=searchbox"],
        ['<div role="search"><input id="f"></div>', "inside role=search"],
        ['<input id="f" name="q">', "name=q"],
        ['<input id="f" name="pveGlobalSearchField-1020-inputEl">', "the name"],
        ['<input id="f" placeholder="Suche">', "a German placeholder"],
        ['<input id="f" aria-label="Search the docs">', "aria-label"]
    ])("sees %s (%s)", html => {
        document.body.innerHTML = html;
        expect(looksLikeSearchField(el("f"))).toBe(true);
    });

    it("sees a label saying so", () => {
        document.body.innerHTML = '<input id="f" name="x">';
        expect(looksLikeSearchField(el("f"), ["Search"])).toBe(true);
    });

    it("leaves login fields alone", () => {
        document.body.innerHTML =
            '<input id="f" name="username" placeholder="User name" autocomplete="username">';
        expect(looksLikeSearchField(el("f"), ["User name:"])).toBe(false);
    });
});

describe("isSwitchedOff", () => {
    it("sees inert and aria-hidden around the field, also across a shadow root", () => {
        document.body.innerHTML = `
            <div inert><input id="a"></div>
            <div aria-hidden="true"><div><input id="b"></div></div>
            <div aria-hidden="false"><input id="c"></div>
            <div aria-hidden="true"><x-box id="host"></x-box></div>`;
        const shadow = el("host").attachShadow({ mode: "open" });
        shadow.innerHTML = '<input id="d">';

        expect(isSwitchedOff(el("a"))).toBe(true);
        expect(isSwitchedOff(el("b"))).toBe(true);
        expect(isSwitchedOff(el("c"))).toBe(false);
        expect(isSwitchedOff(el("d", shadow))).toBe(true);
    });
});

describe("stepsToMeet", () => {
    it("counts up from the password field to where the two meet", () => {
        document.body.innerHTML = `
            <div class="header"><input id="search"></div>
            <div class="login"><div><input id="user"></div><div><input id="pass"></div></div>`;
        // pass > div > div.login
        expect(stepsToMeet(el("user"), el("pass"))).toBe(2);
        // pass > div > div.login > body
        expect(stepsToMeet(el("search"), el("pass"))).toBe(3);
    });

    it("steps out of shadow roots", () => {
        document.body.innerHTML = '<div class="login"><x-user id="host"></x-user><input id="pass"></div>';
        const shadow = el("host").attachShadow({ mode: "open" });
        shadow.innerHTML = '<input id="user">';
        // pass > div.login
        expect(stepsToMeet(el("user", shadow), el("pass"))).toBe(1);
    });
});
