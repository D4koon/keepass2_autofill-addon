export type ButtonAction =
    | "enableHighSecurityKPRPCConnection"
    | "disableNotifyWhenEntryUpdated"
    | "launchLoginEditorFromNotification";

export interface Button {
    label: string;
    action?: ButtonAction;
    id?: string;
    tooltip?: string;
    values?: { [id: string]: string };
}
