import { describe, expect, it } from "vitest";
import { Entry } from "../common/model/Entry";
import { Group } from "../common/model/Group";
import { Database } from "../common/model/Database";
import { Field } from "../common/model/Field";
import { DatabaseSummary } from "../common/model/DatabaseSummary";
import { FormFieldTypeDTO } from "../common/model/KPRPCDTOs";
import { SessionType } from "../common/SessionType";

const field = (over: Partial<Record<string, unknown>> = {}) => ({
    displayName: "",
    name: "",
    value: "",
    id: "",
    type: FormFieldTypeDTO.text,
    page: 1,
    ...over
});

const groupSummary = (over = {}) => ({
    title: "Root",
    uniqueID: "g-root",
    iconImageData: "",
    path: "/",
    ...over
});

describe("Field.fromKPRPCFieldDTO", () => {
    it("maps KPRPC field types to the internal field/locator types", () => {
        expect(Field.fromKPRPCFieldDTO(field({ type: FormFieldTypeDTO.password })).type).toBe(
            "password"
        );
        expect(Field.fromKPRPCFieldDTO(field({ type: FormFieldTypeDTO.username })).type).toBe(
            "text"
        );
        expect(Field.fromKPRPCFieldDTO(field({ type: FormFieldTypeDTO.checkbox })).type).toBe(
            "boolean"
        );
        expect(Field.fromKPRPCFieldDTO(field({ type: FormFieldTypeDTO.select })).type).toBe(
            "existing"
        );
    });

    it("prefers displayName over name and carries the value into locators", () => {
        const f = Field.fromKPRPCFieldDTO(
            field({ displayName: "User", name: "u", value: "alice", id: "userid" })
        );
        expect(f.name).toBe("User");
        expect(f.value).toBe("alice");
        expect(f.locators[0]).toMatchObject({ id: "userid", name: "u" });
    });
});

describe("Entry.fromKPRPCEntryDTO", () => {
    const dto = (over = {}) => ({
        db: { name: "db", fileName: "d.kdbx", iconImageData: "", root: groupSummary() },
        parent: groupSummary({ title: "Logins", uniqueID: "g1", path: "/Logins" }),
        iconImageData: "",
        alwaysAutoFill: false,
        alwaysAutoSubmit: false,
        neverAutoFill: false,
        neverAutoSubmit: true,
        priority: 0,
        uRLs: ["https://site.example/"],
        matchAccuracy: 40,
        hTTPRealm: "",
        uniqueID: "e1",
        title: "Site",
        formFieldList: [
            field({ name: "extra", value: "x", type: FormFieldTypeDTO.text }),
            field({ name: "pw", value: "secret", type: FormFieldTypeDTO.password }),
            field({ name: "user", value: "alice", type: FormFieldTypeDTO.username })
        ],
        ...over
    });

    const db = DatabaseSummary.fromKPRPCDatabaseSummaryDTO({
        name: "db",
        fileName: "d.kdbx",
        iconImageData: "",
        root: groupSummary()
    });

    it("copies scalar properties across", () => {
        const e = Entry.fromKPRPCEntryDTO(dto() as never, db);
        expect(e).toMatchObject({
            uuid: "e1",
            title: "Site",
            URLs: ["https://site.example/"],
            matchAccuracy: 40,
            neverAutoSubmit: true
        });
        expect(e.parentGroup.title).toBe("Logins");
    });

    it("sorts fields as username, then password, then the rest", () => {
        const e = Entry.fromKPRPCEntryDTO(dto() as never, db);
        expect(e.fields.map(f => f.type)).toEqual(["text", "password", "text"]);
        expect(e.fields[0].value).toBe("alice"); // username first
        expect(e.fields[1].value).toBe("secret"); // password second
        expect(e.fields[2].value).toBe("x"); // extra last
    });

    it("Entry.getUsernameField / getPasswordField find the mapped fields", () => {
        const e = Entry.fromKPRPCEntryDTO(dto() as never, db);
        expect(Entry.getUsernameField(e)?.value).toBe("alice");
        expect(Entry.getPasswordField(e)?.value).toBe("secret");
    });
});

describe("Group.fromKPRPCGroupDTO", () => {
    const groupDto = {
        title: "Root",
        uniqueID: "g-root",
        iconImageData: "",
        path: "/",
        childLightEntries: [
            {
                iconImageData: "",
                uRLs: ["https://a.example/"],
                uniqueID: "s1",
                title: "A",
                usernameValue: "alice",
                usernameName: "user"
            }
        ],
        childGroups: [
            {
                title: "Sub",
                uniqueID: "g-sub",
                iconImageData: "",
                path: "/Sub",
                childLightEntries: [
                    {
                        iconImageData: "",
                        uRLs: ["https://b.example/"],
                        uniqueID: "s2",
                        title: "B",
                        usernameValue: "bob",
                        usernameName: "user"
                    }
                ],
                childGroups: []
            }
        ]
    };

    it("builds a nested Group tree with EntrySummaries", () => {
        const g = Group.fromKPRPCGroupDTO(groupDto as never, "d.kdbx");
        expect(g.title).toBe("Root");
        expect(g.entrySummaries.map(e => e.title)).toEqual(["A"]);
        expect(g.entrySummaries[0].dbFileName).toBe("d.kdbx");
        expect(g.entrySummaries[0].url).toBe("https://a.example/");
        expect(g.groups).toHaveLength(1);
        expect(g.groups[0].entrySummaries[0].title).toBe("B");
    });
});

describe("Database.fromKPRPCDatabaseDTO", () => {
    it("carries name, fileName, session type/features and builds the root group", () => {
        const dbDto = {
            name: "My DB",
            fileName: "my.kdbx",
            iconImageData: "",
            active: true,
            root: {
                title: "Root",
                uniqueID: "r",
                iconImageData: "",
                path: "/",
                childLightEntries: [],
                childGroups: []
            }
        };
        const d = Database.fromKPRPCDatabaseDTO(
            dbDto as never,
            SessionType.Websocket,
            ["FEATURE_X"]
        );
        expect(d).toMatchObject({
            name: "My DB",
            fileName: "my.kdbx",
            active: true,
            sessionType: SessionType.Websocket,
            sessionFeatures: ["FEATURE_X"]
        });
        expect(d.root.title).toBe("Root");
    });
});
