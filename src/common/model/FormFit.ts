// How well an entry fits a login form on the current page - transient, worked
// out by the content script (page/formFit.ts), never stored in KeePass.

// Why an entry isn't filled on its own on this form
export type FitBlocker =
    // No visible password field to fill, nor a username field on a first step
    | { code: "no-login-field" }
    // A new-password field, or two password fields: signing up or changing it
    | { code: "sign-up-form" }
    // More text fields the entry has nothing for than a login has (a captcha)
    | { code: "extra-fields"; fields: string[] };

export interface FormFit {
    // What the form offers for logging in, visible and reachable: a password
    // field, or on the first step of a two-step login a username field
    loginField: "password" | "username" | null;
    // How many of the entry's fields have a stored id or name a page field matches
    storedMatches: number;
    // Why the entry isn't filled without a click; null when it is
    blocker: FitBlocker | null;
}
