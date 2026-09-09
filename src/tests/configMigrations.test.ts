import { beforeEach, describe, expect, it } from "vitest";
import { ConfigMigrations } from "../common/ConfigMigrations";
import { Config } from "../common/config";
import { configManager, LATEST_VERSION } from "../common/ConfigManager";

const m = new ConfigMigrations();

// A migration only touches the handful of fields it cares about, so a bare
// object cast to Config is enough for the per-step tests.
const cfg = (over: Partial<Config> = {}) => ({ ...over }) as Config;

describe("ConfigMigrations - per step", () => {
    it("v3 seeds notification counters and the search timeout", () => {
        const c = cfg({ version: 2 });
        m.migrateToVersion3(c);
        expect(c).toMatchObject({
            version: 3,
            notificationCountGeneric: 0,
            notificationCountSavePassword: 0,
            currentSearchTermTimeout: 30
        });
    });

    it("v3 keeps existing notification counters", () => {
        const c = cfg({ version: 2, notificationCountGeneric: 4 } as Partial<Config>);
        m.migrateToVersion3(c);
        expect(c.notificationCountGeneric).toBe(4);
    });

    it("v4 maps logLevel: 1 stays 1, anything else becomes 2", () => {
        const a = cfg({ version: 3, logLevel: 1 });
        m.migrateToVersion4(a);
        expect(a).toMatchObject({ version: 4, logLevel: 1 });

        const b = cfg({ version: 3, logLevel: 4 });
        m.migrateToVersion4(b);
        expect(b).toMatchObject({ version: 4, logLevel: 2 });
    });

    it("v5 enables notifyPasswordAvailableForPaste", () => {
        const c = cfg({ version: 4 });
        m.migrateToVersion5(c);
        expect(c).toMatchObject({ version: 5, notifyPasswordAvailableForPaste: true });
    });

    it("v6 enables animateWhenOfferingSave", () => {
        const c = cfg({ version: 5 });
        m.migrateToVersion6(c);
        expect(c).toMatchObject({ version: 6, animateWhenOfferingSave: true });
    });

    it("v7 clamps notificationCountSavePassword to 6", () => {
        const high = cfg({ version: 6, notificationCountSavePassword: 12 });
        m.migrateToVersion7(high);
        expect(high).toMatchObject({ version: 7, notificationCountSavePassword: 6 });

        const low = cfg({ version: 6, notificationCountSavePassword: 2 });
        m.migrateToVersion7(low);
        expect(low).toMatchObject({ version: 7, notificationCountSavePassword: 2 });
    });

    it("v8 forces overWriteFieldsAutomatically off", () => {
        const c = cfg({ version: 7, overWriteFieldsAutomatically: true });
        m.migrateToVersion8(c);
        expect(c).toMatchObject({ version: 8, overWriteFieldsAutomatically: false });
    });
});

describe("ConfigMigrations - full chain via ConfigManager.load()", () => {
    beforeEach(() => {
        configManager.resetToDefault();
    });

    async function loadStored(obj: Record<string, unknown>) {
        const str = JSON.stringify(obj);
        await chrome.storage.local.set({ keeConfigPageCount: 1, keeConfigPage0: str });
        await configManager.load();
    }

    it("migrates a v5 config all the way to the latest version", async () => {
        await loadStored({
            version: 5,
            logLevel: 3,
            notificationCountSavePassword: 20,
            overWriteFieldsAutomatically: true,
            animateWhenOfferingSave: false,
            notifyPasswordAvailableForPaste: false
        });

        const c = configManager.current;
        expect(c.version).toBe(LATEST_VERSION);
        expect(c.animateWhenOfferingSave).toBe(true); // v6
        expect(c.notificationCountSavePassword).toBe(6); // v7 clamp
        expect(c.overWriteFieldsAutomatically).toBe(false); // v8
    });

    it("leaves an already-current config untouched", async () => {
        await loadStored({ version: LATEST_VERSION, logLevel: 1 });
        expect(configManager.current.version).toBe(LATEST_VERSION);
        expect(configManager.current.logLevel).toBe(1);
    });
});
