<template>
    <div class="diag-report">
        <div class="diag-toolbar">
            <span class="diag-title">{{ title }}</span>
            <v-btn size="small" variant="tonal" color="primary" @click="copy">
                <mdi-check v-if="copied" class="mr-1" />
                <mdi-content-copy v-else class="mr-1" />
                {{ $i18n("copy") }}
            </v-btn>
        </div>

        <div
            v-for="(l, index) of parsedLines"
            :key="index"
            :class="['diag-' + l.kind, { 'diag-status': isStatus(l.kind) }]">
            <template v-if="l.kind === 'kv'">
                <span class="diag-key">{{ l.key }}</span>
                <span class="diag-value">{{ l.text }}</span>
            </template>
            <template v-else-if="isStatus(l.kind)">
                <span class="diag-icon">{{ icons[l.kind] }}</span>
                <span>{{ l.text }}</span>
            </template>
            <template v-else>
                {{ l.text }}
            </template>
        </div>
    </div>
</template>

<script lang="ts">
import {
    DiagLineKind,
    diagReportToPlainText,
    parseDiagLine
} from "../../common/diagnosisReport";
import { copyStringToClipboard } from "../../common/copyStringToClipboard";

export default {
    props: {
        lines: { type: Array as () => string[], required: true }
    },
    data: () => ({
        copied: false,
        icons: { ok: "✔", warn: "⚠", error: "✖", info: "ℹ" } as Record<string, string>
    }),
    computed: {
        allParsed() {
            return (this.lines as string[]).map(parseDiagLine);
        },
        title() {
            return this.allParsed.find(l => l.kind === "title")?.text ?? "";
        },
        parsedLines() {
            return this.allParsed.filter(l => l.kind !== "title");
        }
    },
    methods: {
        isStatus(kind: DiagLineKind) {
            return kind === "ok" || kind === "warn" || kind === "error" || kind === "info";
        },
        async copy() {
            await copyStringToClipboard(diagReportToPlainText(this.lines));
            this.copied = true;
            setTimeout(() => (this.copied = false), 1500);
        }
    }
};
</script>

<style scoped>
.diag-report {
    font-size: 0.8rem;
    line-height: 1.35;
    color: rgb(var(--v-theme-on-surface));
    overflow-wrap: anywhere;
}
.diag-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 4px;
}
.diag-title {
    font-size: 1rem;
    font-weight: 600;
}
.diag-frame {
    margin: 12px 0 2px;
    padding: 4px 8px;
    border-radius: 4px;
    background: rgba(var(--v-theme-on-surface), 0.08);
    font-weight: 600;
}
.diag-heading {
    margin: 10px 0 4px;
    padding-bottom: 2px;
    border-bottom: 1px solid rgba(var(--v-theme-on-surface), 0.2);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    font-size: 0.72rem;
    opacity: 0.85;
}
.diag-kv {
    display: grid;
    grid-template-columns: 9em 1fr;
    column-gap: 8px;
    padding: 1px 0;
}
.diag-key {
    opacity: 0.7;
}
.diag-value {
    font-family: ui-monospace, Consolas, monospace;
    font-size: 0.75rem;
    max-height: 4.2em;
    overflow-y: auto;
}
.diag-status {
    display: flex;
    gap: 6px;
    margin: 4px 0;
    padding: 4px 6px;
    border-radius: 4px;
    border-left: 3px solid;
}
.diag-icon {
    flex: none;
    width: 1em;
    text-align: center;
}
.diag-ok {
    border-color: #2e7d32;
    background: rgba(46, 125, 50, 0.1);
}
.diag-warn {
    border-color: #ed6c02;
    background: rgba(237, 108, 2, 0.1);
}
.diag-error {
    border-color: #d32f2f;
    background: rgba(211, 47, 47, 0.1);
}
.diag-info {
    border-color: #0288d1;
    background: rgba(2, 136, 209, 0.08);
}
.diag-bullet {
    position: relative;
    padding-left: 14px;
}
.diag-bullet::before {
    content: "•";
    position: absolute;
    left: 4px;
}
.diag-code {
    margin: 4px 0 4px 14px;
    padding: 4px 6px;
    border-radius: 4px;
    background: rgba(var(--v-theme-on-surface), 0.06);
    font-family: ui-monospace, Consolas, monospace;
    font-size: 0.7rem;
    max-height: 6em;
    overflow-y: auto;
}
.diag-text {
    margin-top: 4px;
}
</style>
