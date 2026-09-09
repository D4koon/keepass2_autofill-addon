import { beforeEach, describe, expect, it, vi } from "vitest";
import { jsonrpcClient } from "../background/jsonrpcClient";
import { WebsocketSessionManager } from "../background/WebsocketSession";
import { SessionType } from "../common/SessionType";
import { FormFieldTypeDTO } from "../common/model/KPRPCDTOs";
import { configManager } from "../common/ConfigManager";
import { kee } from "../background/KF";

// Exercises the request-orchestration + DTO-to-model mapping in jsonrpcClient
// against a fake transport, so we do not need a live KeePassRPC WebSocket.

const wsSM = Object.create(WebsocketSessionManager.prototype) as WebsocketSessionManager;

function makeClient(requestImpl: (method: string, params: unknown[]) => unknown[]) {
    // Skip the real constructor (it starts a WebSocket session manager) and
    // wire in a fake store + transport. Cast through `any` because `kprpcClient`
    // is a private field on the class.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client: any = Object.create(jsonrpcClient.prototype);
    client.store = {
        state: {
            ActiveKeePassDatabaseIndex: 0,
            KeePassDatabases: [{ fileName: "d.kdbx", sessionType: SessionType.Websocket }],
            PasswordProfiles: [{ name: "Default", sessionType: SessionType.Websocket }]
        }
    };
    client.kprpcClient = {
        getSessionManagerByType: () => wsSM,
        getManagersForActiveSessions: () => [wsSM],
        request: vi.fn(async (_sms: unknown, method: string, params: unknown[]) =>
            requestImpl(method, params)
        )
    };
    return client as unknown as jsonrpcClient;
}

const dbSummaryDto = {
    name: "d",
    fileName: "d.kdbx",
    iconImageData: "",
    root: { title: "Root", uniqueID: "r", iconImageData: "", path: "/" }
};

const entryDto = (uuid: string, title: string, url: string) => ({
    db: dbSummaryDto,
    parent: { title: "Root", uniqueID: "r", iconImageData: "", path: "/" },
    iconImageData: "",
    alwaysAutoFill: false,
    alwaysAutoSubmit: false,
    neverAutoFill: false,
    neverAutoSubmit: false,
    priority: 0,
    uRLs: [url],
    matchAccuracy: 40,
    hTTPRealm: "",
    uniqueID: uuid,
    title,
    formFieldList: [
        { displayName: "u", name: "u", value: "user", id: "", type: FormFieldTypeDTO.username, page: 1 },
        { displayName: "p", name: "p", value: "pass", id: "", type: FormFieldTypeDTO.password, page: 1 }
    ]
});

const wsResponse = (result: unknown) => [
    { sessionType: SessionType.Websocket, features: [], resultWrapper: { result } }
];

beforeEach(() => {
    configManager.resetToDefault(); // searchAllOpenDBs = true
});

describe("jsonrpcClient.findLogins", () => {
    it("maps a FindLogins response into Entry objects", async () => {
        const client = makeClient((method, params) => {
            expect(method).toBe("FindLogins");
            expect(params[0]).toEqual(["https://site.example/"]); // urls
            return wsResponse([
                entryDto("e1", "One", "https://site.example/"),
                entryDto("e2", "Two", "https://site.example/login")
            ]);
        });

        const entries = await client.findLogins(
            "https://site.example/",
            null,
            null,
            null,
            null,
            null
        );

        expect(entries.map(e => e.uuid)).toEqual(["e1", "e2"]);
        expect(entries[0].title).toBe("One");
        expect(entries[0].database.fileName).toBe("d.kdbx");
        expect(entries[0].fields.map(f => f.type)).toEqual(["text", "password"]);
    });

    it("returns [] when there are no databases", async () => {
        const client = makeClient(() => wsResponse([]));
        (client as unknown as { store: { state: { KeePassDatabases: unknown[] } } }).store.state.KeePassDatabases =
            [];
        expect(await client.findLogins("https://x/", null, null, null, null, null)).toEqual([]);
    });

    it("returns [] when the server sends an empty result", async () => {
        const client = makeClient(() => wsResponse(null));
        expect(await client.findLogins("https://x/", null, null, null, null, null)).toEqual([]);
    });
});

describe("jsonrpcClient.getPasswordProfiles", () => {
    it("dedupes profile names and tags them with the session type", async () => {
        const client = makeClient(() => wsResponse(["Default", "Strong", "Default"]));
        const profiles = await client.getPasswordProfiles();
        expect(profiles).toEqual([
            { name: "Default", sessionType: SessionType.Websocket },
            { name: "Strong", sessionType: SessionType.Websocket }
        ]);
    });
});

describe("jsonrpcClient.generatePassword", () => {
    it("returns the generated password string from the response", async () => {
        const client = makeClient((method, params) => {
            expect(method).toBe("GeneratePassword");
            expect(params).toEqual(["Default", "https://site.example/"]);
            return wsResponse("Xy9!generated");
        });
        expect(await client.generatePassword("Default", "https://site.example/")).toBe(
            "Xy9!generated"
        );
    });
});

describe("jsonrpcClient.getAllDatabases", () => {
    it("maps databases and hands them to kee.updateKeePassDatabases, ignoring duplicates", async () => {
        const spy = vi
            .spyOn(kee, "updateKeePassDatabases")
            .mockImplementation(() => undefined);

        const grp = {
            title: "Root",
            uniqueID: "r",
            iconImageData: "",
            path: "/",
            childLightEntries: [],
            childGroups: []
        };
        const client = makeClient(() =>
            wsResponse([
                { name: "A", fileName: "a.kdbx", iconImageData: "", root: grp },
                { name: "A dup", fileName: "a.kdbx", iconImageData: "", root: grp },
                { name: "B", fileName: "b.kdbx", iconImageData: "", root: grp }
            ])
        );

        await client.getAllDatabases();

        expect(spy).toHaveBeenCalledOnce();
        const dbs = spy.mock.calls[0][0];
        expect(dbs.map(d => d.fileName)).toEqual(["a.kdbx", "b.kdbx"]);
        spy.mockRestore();
    });
});
