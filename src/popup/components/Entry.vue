<template>
    <v-hover>
        <template #default="{ isHovering, props }">
            <v-card
            v-bind="props"
ref="card" :data-index="dataIndex" :tabindex="`${tabindex}`" :elevation="isHovering ? 12 : 3" class="my-2"
                :ripple="false" @focusin="focusin" @focusout="focusout"
                @keyup.context-menu.stop.prevent="showFullDetails" @keyup.arrow-down.stop.prevent="nextInList"
                @keyup.arrow-up.stop.prevent="prevInList" @keyup.arrow-right.stop.prevent="showFullDetails"
                @keyup.arrow-left.stop.prevent="hideFullDetails" @keyup.escape.stop.prevent="exitList"
                @keyup.enter.self.stop.prevent="primaryClickAction" @keyup.enter.ctrl.self.stop.prevent="loadInNewTab">
                <v-container class="ma-0 pa-0 my-2" :style="titleStyle">
                            <v-hover>
                    <v-sheet
class="mr-3 ml-12 my-0"
                        :style="`display: flex; align-items:center; justify-content:space-between; ${isHovering ? 'cursor: pointer' : ''}; column-gap:0.5rem;`" @click.left.exact="primaryClickAction"
                        @click.middle.exact="loadInNewTab" @click.left.ctrl="loadInNewTab"
                        @click.middle.ctrl="primaryClickAction" @click.right.stop.prevent="showFullDetails">
                        <v-sheet class="text-truncate">
                                <v-container fluid class="ma-0 pa-0" style="padding: 0px;">
                                    <v-row no-gutters class="my-0">
                                        <v-col class="text-truncate">
                                            {{ entrySummary.title }}
                                        </v-col>
                                    </v-row>
                                    <v-row no-gutters class="my-0">
                                        <v-col
:style="`${expanded ? 'visibility:hidden' : ''}`"
                                            class="text-truncate text-caption">
                                            {{ usernameDisplayValue }}
                                        </v-col>
                                    </v-row>
                                    <v-row v-if="showAutoFillReason && !expanded" no-gutters class="my-0">
                                        <v-col
                                            class="text-truncate text-caption d-flex align-center"
                                            :class="autoFillReasonBlocked ? 'text-warning' : 'text-success'">
                                            <v-tooltip
                                                v-if="autoFillReasonTooltip" location="top"
                                                :open-delay="tooltipDelay" activator="parent">
                                                <span>{{ autoFillReasonTooltip }}</span>
                                            </v-tooltip>
                                            <mdi-alert-circle-outline v-if="autoFillReasonBlocked" class="mr-1" />
                                            <mdi-check-circle-outline v-else class="mr-1" />
                                            {{ autoFillReasonText }}
                                        </v-col>
                                    </v-row>
                                </v-container>
                        </v-sheet>
                        <v-sheet v-if="isHovering || focussed" class="align-self-center">
                            <v-btn
variant="elevated" color="secondary" size="x-small" icon
                                @click.stop.prevent="toggleFullDetails">
                                <mdi-chevron-down v-if="!expanded" scale="200" />
                                <mdi-chevron-up v-if="expanded" scale="200" />
                            </v-btn>
                        </v-sheet>
                    </v-sheet>
                            </v-hover>
                </v-container>
                <v-card-text class="text-truncate" style="cursor: default; padding: 0px;">
                    <v-slide-y-transition>
                        <v-container v-if="expanded && !!entrySummary.fullDetails" class="my-0 pa-0 mx-2">
                            <Field v-for="f of allFields" :key="f.uuid" :field="f" />
                            <v-sheet class="my-0" style="display: flex; justify-content: space-between;">
                                <v-sheet class="text-truncate">
                                    <v-sheet class="text-truncate my-0" style="flex-wrap: nowrap; display: flex; align-items: center;">
                                        <v-tooltip
location="top" :disabled="!entryPathIsLong"
                                            :open-delay="tooltipDelay" activator="parent">
                                            <span>{{ fullEntryPath }}</span>
                                        </v-tooltip>
                                        <mdi-folder class="mr-2" />
                                        <span class="text-truncate text-caption py-1">{{
                                            entryPath
                                        }}</span>
                                    </v-sheet>
                                    <v-sheet class="text-truncate my-0" style="flex-wrap: nowrap; display: flex; align-items: center;">
                                        <v-tooltip location="top" :open-delay="tooltipDelay" activator="parent">
                                            <span>{{ entrySummary.url }}</span>
                                        </v-tooltip>
                                        <mdi-cloud class="mr-2" />
                                        <span class="text-truncate text-caption py-1">{{
                                            entryDomain
                                        }}</span>
                                    </v-sheet>
                                </v-sheet>

                                <v-sheet class="ma-2 shrink" style="display: flex; column-gap: 4px;">
                                    <v-btn
v-if="isSearchResult" size="small" location="bottom left"
                                        icon="mdi-help-circle-outline" :title="$i18n('diagnose_fill_here')"
                                        @click="diagnoseFillHere">
                                    </v-btn>
                                    <v-btn size="small" location="bottom left" icon="mdi-pencil" @click="editEntry">
                                    </v-btn>
                                </v-sheet>
                            </v-sheet>
                            <v-row v-if="isMatchedEntry" justify="space-between" align="center">
                                <v-col class="text-truncate pt-0 ma-0">
                                    <v-divider class="mt-4 mx-5"></v-divider>
                                    <v-checkbox
:label="$i18n('preferred_matching_entry')"
                                        :model-value="entrySummary.isPreferredMatch"
                                        @update:model-value="onPreferredEntryClick"></v-checkbox>
                                </v-col>
                            </v-row>
                        </v-container>
                    </v-slide-y-transition>
                </v-card-text>
            </v-card>
        </template>
    </v-hover>
</template>

<script lang="ts">
import Field from "./Field.vue";
import { AddonMessage } from "../../common/AddonMessage";
import { Port } from "../../common/port";
import useStore from "../../store";
import { KeeURL } from "../../common/KeeURL";
import { Action } from "../../common/Action";
import { supplementEntryState } from "../supplementEntryState";
import { reconcileURLs } from "../reconcileURLs";
import { SaveState } from "../../common/SaveState";
import { Entry } from "../../common/model/Entry";
import { EntrySummary } from "../../common/model/EntrySummary";
import { tooltipDelay } from "../../common/Timings";
import { mapState } from "pinia";
import { $STR, $STRF } from "~/common/DollarPolyfills";

export default {
    components: { Field },
    props: ["entrySummary", "isFirstInAList", "entryIndex", "frameId", "dataIndex"],
    emits: ["move-next-in-list", "move-prev-in-list", "move-out-of-list", "pref-entry-toggle"],
    setup() {
        const { updateSaveState } = useStore();
        return { updateSaveState };
    },
    data: () => ({
        expanded: false,
        focussed: false,
        tooltipDelay: tooltipDelay
    }),
    computed: {
        ...mapState(useStore, ["saveState"]),
        titleStyle: function () {
            const e = this.entrySummary as EntrySummary;
            return (
                "padding: 0px; background-size:32px; background-position: 8px calc(50% + 0px); background-repeat: no-repeat; background-image:url(data:image/png;base64," +
                e.icon.iconImageData +
                ")"
            );
        },
        usernameDisplayValue: function () {
            const e = this.entrySummary as EntrySummary;
            return e && e.usernameValue
                ? e.usernameValue
                : "[" + $STR("noUsername_partial_tip") + "]";
        },
        tabindex: function () {
            return "0"; //this.isFirstInAList ? "0" : "-1"; // new treeview component needs this to be 0 for everything
        },
        allFields: function () {
            const e = this.entrySummary.fullDetails as Entry;
            return e.fields;
        },
        entryDomain: function () {
            const urlStr = this.entrySummary.url;
            if (!urlStr || urlStr.length < 4) return "<unknown>";
            const kurl = KeeURL.fromString(urlStr);
            if (!kurl) {
                return "<error>";
            }
            return kurl.domainWithPort || kurl.url.host;
        },
        entryPath: function () {
            if (!this.entryPathIsLong) {
                return this.fullEntryPath;
            }
            const e = this.entrySummary.fullDetails as Entry;
            return "... > " + e.parentGroup.path;
        },
        entryPathIsLong: function () {
            return this.fullEntryPath.length > 35;
        },
        fullEntryPath: function () {
            const e = this.entrySummary.fullDetails as Entry;
            return e.database.name + " > " + e.parentGroup.path;
        },
        isMatchedEntry: function () {
            const e = this.entrySummary as EntrySummary;
            return typeof e.isPreferredMatch === "boolean";
        },
        isSearchResult: function () {
            // No entryIndex means this came from the search box rather than the
            // automatically matched list, so a click navigates instead of filling.
            return this.entryIndex === undefined || this.entryIndex === null;
        },
        autoFillReasonBlocked: function () {
            const e = this.entrySummary as EntrySummary;
            return !!e.autoFillReason && e.autoFillReason.blocked;
        },
        showAutoFillReason: function () {
            return this.isMatchedEntry && !!this.autoFillReasonText;
        },
        // Short label that fits a narrow popup card on one line. Hover it (see
        // autoFillReasonTooltip) for the full explanation.
        autoFillReasonText: function () {
            const r = (this.entrySummary as EntrySummary).autoFillReason;
            if (!r) return null;
            switch (r.code) {
                case "fills-here":
                    return $STR("autofill_status_fills_here");
                case "autofill-disabled":
                    return $STR("autofill_blocked_disabled_short");
                case "context-notify-only":
                    return $STR("autofill_blocked_notify_only_short");
                case "multiple-matches":
                    return $STRF("autofill_blocked_multiple_short", [
                        String(r.matchCount ?? "")
                    ]);
                case "entry-never":
                    return $STR("autofill_blocked_entry_never_short");
                case "low-relevance":
                    return $STR("autofill_blocked_low_relevance_short");
                case "low-field-match":
                    return $STR("autofill_blocked_low_field_match_short");
                default:
                    return null;
            }
        },
        autoFillReasonTooltip: function () {
            const r = (this.entrySummary as EntrySummary).autoFillReason;
            if (!r || r.code === "fills-here") return null;
            switch (r.code) {
                case "autofill-disabled":
                    return $STR("autofill_blocked_disabled");
                case "context-notify-only":
                    return $STR("autofill_blocked_notify_only");
                case "multiple-matches":
                    return $STRF("autofill_blocked_multiple", [String(r.matchCount ?? "")]);
                case "entry-never":
                    return $STR("autofill_blocked_entry_never");
                case "low-relevance":
                    return $STR("autofill_blocked_low_relevance");
                case "low-field-match":
                    return $STR("autofill_blocked_low_field_match");
                default:
                    return null;
            }
        }
    },
    methods: {
        toggleFullDetails() {
            if (!this.expanded) {
                this.showFullDetails();
            } else {
                this.hideFullDetails();
            }
        },
        showFullDetails() {
            if (!this.expanded && !this.entrySummary.fullDetails) {
                Port.postMessage({
                    findMatches: {
                        uuid: this.entrySummary.uuid,
                        DBfilename: this.entrySummary.dbFileName
                    }
                } as AddonMessage);
            }
            this.expanded = true;
        },
        hideFullDetails() {
            this.expanded = false;
        },
        async editEntry() {
            const ss = this.saveState as SaveState;
            const entry = this.entrySummary.fullDetails as Entry;
            const updatedSaveState = Object.assign({}, ss);
            const { urls, showWarning } = await reconcileURLs(entry.URLs, ss.submittedData?.url);
            updatedSaveState.newEntry = supplementEntryState(entry, ss, urls);
            updatedSaveState.titleResetValue = entry.title;
            updatedSaveState.lastActiveAt = new Date();
            updatedSaveState.showURLMismatchWarning = showWarning;
            //TODO: Confirm that we don't have to roundtrip JSON here too
//            this.updateSaveState(JSON.parse(JSON.stringify(updatedSaveState)));
            this.updateSaveState(updatedSaveState);
        },
        focusin: function (e) {
            if (!(this.$refs.card as any).$el.contains(e.relatedTarget)) {
                this.focussed = true;
            }
        },
        focusout: function (e) {
            if (!(this.$refs.card as any).$el.contains(e.relatedTarget)) {
                this.focussed = false;
            }
        },
        async primaryClickAction() {
            if (this.entryIndex !== undefined) {
                // We are expected to fill an already discovered entry
                this.manualFill();
            } else {
                // Overwriting the Kee Vault tab causes much confusion so prevent that from happening
                const currentTab = await chrome.tabs.query({
                    currentWindow: true,
                    active: true,
                    url: [
                        "https://keevault.pm/*",
                        "https://app-beta.kee.pm/*",
                        "https://app-dev.kee.pm/*"
                    ]
                });
                if (currentTab && currentTab.length > 0) {
                    this.loadInNewTab();
                } else {
                    this.loadInSameTab();
                }
            }
        },
        loadInSameTab() {
            chrome.tabs.update({ url: this.entrySummary.url });
            window.close();
        },
        loadInNewTab() {
            chrome.tabs.create({ url: this.entrySummary.url });
            window.close();
        },
        manualFill() {
            Port.postMessage({
                action: Action.ManualFill,
                selectedEntryIndex: this.entryIndex,
                frameId: this.frameId
            });
            window.close();
        },
        diagnoseFillHere() {
            // Ask the page script to run this entry through the real matching + fill
            // pipeline on the current page and report back why it does / doesn't fill.
            // Keep the popup open so the resulting notification is visible.
            Port.postMessage({
                diagnoseFill: {
                    uuid: this.entrySummary.uuid,
                    DBfilename: this.entrySummary.dbFileName
                },
                frameId: this.frameId ?? 0
            } as AddonMessage);
        },
        nextInList() {
            this.$emit("move-next-in-list");
        },
        prevInList() {
            this.$emit("move-prev-in-list");
        },
        exitList() {
            this.$emit("move-out-of-list");
        },
        onPreferredEntryClick() {
            // json may be unncessary
            this.$emit("pref-entry-toggle", { uuid: JSON.parse(JSON.stringify(this.entrySummary.uuid)) });
        }
    }
};
</script>
