import { KeeURL } from "../common/KeeURL";

// How long a manual pick stays usable for the next step of a login
export const MANUAL_PICK_TTL_MS = 60 * 1000;

export type ManualPick = { uuid: string; at: number };

// The entry the user last filled by hand in each tab, so a login that loads a
// new page for its next step (username first, then the password) fills the
// same entry there even when several entries match. Kept per tab and site:
// another tab or another site never sees it. The page reports when it used
// the pick, which ends it, so a wrong password can't make us refill in a loop.
export class ManualPicks {
    private picks = new Map<number, ManualPick & { site: string }>();

    public remember(tabId: number, uuid: string, url: string, now = Date.now()) {
        const site = siteOf(url);
        if (!uuid || !site) return;
        this.picks.set(tabId, { uuid, at: now, site });
    }

    // The tab's pick, if it is still fresh and from the same site as `url`
    public forPage(tabId: number, url: string, now = Date.now()): ManualPick | undefined {
        const pick = this.picks.get(tabId);
        if (!pick) return undefined;
        if (now - pick.at > MANUAL_PICK_TTL_MS) {
            this.picks.delete(tabId);
            return undefined;
        }
        if (pick.site !== siteOf(url)) return undefined;
        return { uuid: pick.uuid, at: pick.at };
    }

    public forget(tabId: number) {
        this.picks.delete(tabId);
    }
}

// The registrable domain (auth.gmx.net and login.gmx.net are both gmx.net),
// or the address for IP hosts
function siteOf(url: string): string {
    if (!url) return "";
    return KeeURL.fromString(url)?.domainOrIPAddress ?? "";
}
