import {setup as i18nSetup } from "../common/i18n";

const version = chrome.runtime.getManifest().version;
document.title = "KeeLink " + version;
document.querySelectorAll(".extensionVersion").forEach(el => {
    el.textContent = version;
});

i18nSetup();
