<template>
    <v-app>
        <div id="i18n_root">
            <h1 style="font-size: 42px;">
<img
src="/assets/images/64.png"
                    style="margin-bottom: 4px; margin-right: 10px; display: inline;" />{{ $i18n("welcome_to_kee") }}
            </h1>

            <p style="font-weight: bold;">
{{ $i18n("introduction_to_kee") }}
</p>

            <p v-if="showPermissionsInfo">
{{ $i18n("all_sites_permissions_required") }}
</p>

            <v-btn
v-if="showPermissionsInfo" color="primary" style="margin-top: 24px;" size="x-large"
                @click="requestPermissions">{{ $i18n("continue") }}</v-btn>

            <p v-if="showToolbarInfo">
{{ $i18n("recommend_action_button_should_be_pinned") }}
</p>

            <img
v-if="showToolbarInfo" style="margin-top: 24px;" width="309"
                src="/assets/images/pinChromeScreenshot.png" />

            <div v-if="showDatabaseSourceOptions">
                <p>{{ $i18n("kee_works_with_a_password_manager") }}</p>

                <p>{{ $i18n("install_keepass_instructions") }}</p>
            </div>
        </div>
    </v-app>
</template>

<script setup lang="ts">
import { ref } from "vue";
import "../styles";
import { isFirefox } from "webext-detect-page";

async function requestPermissions() {
    const permissionsToRequest = {
        origins: ["<all_urls>"]
    };
    await chrome.permissions.request(permissionsToRequest);
}

async function checkPermissions() {
    const permissionsToCheck = {
        origins: ["<all_urls>"]
    };
    return await chrome.permissions.contains(permissionsToCheck);
}

function initialiseDatabaseSourcePossibilities(permissionsInfoWasShown: boolean = false) {
    showDatabaseSourceOptions.value = true;
    showPermissionsInfo.value = false;
    if (permissionsInfoWasShown) showToolbarInfo.value = false;
}

async function asyncSetup() {
    document.title = "KeeLink " + extensionVersion.value;
    if (await checkPermissions()) {
        initialiseDatabaseSourcePossibilities();
    } else {
        chrome.permissions.onAdded.addListener(async permissions => {
            if (permissions.origins.includes("<all_urls>")) {
                initialiseDatabaseSourcePossibilities(true);
            }
        });
        showPermissionsInfo.value = true;
    }
}

const manifest = chrome.runtime.getManifest();
const showPermissionsInfo = ref(false);
const showDatabaseSourceOptions = ref(false);
const extensionVersion = ref(manifest.version);
const showToolbarInfo = ref(!isFirefox());
asyncSetup.call(this);
</script>

<style>
#main {
    padding: 20px;
    text-align: center;
    background-color: rgb(var(--v-theme-background));
}

.v-application {
    padding: 0px;
    margin: auto;
    max-width: 1000px;
    text-align: center;
}

p {
    padding-top: 24px;
}

a {
    text-decoration: underline;
}

div#i18n_root {
    display: flex;
    flex-direction: column;
    align-items: center;
}
</style>
