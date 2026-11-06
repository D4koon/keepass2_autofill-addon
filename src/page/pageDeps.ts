import { KeeLogger } from "../common/Logger";

// The points system that once lived here is now rules: which page field gets
// which entry field in fieldRanking.ts, how an entry fits a form in formFit.ts.
// This is what the filling code still needs to look at the page.
export interface ScoringDeps {
    isDOMElementVisible(element: HTMLElement): boolean;
    logger: KeeLogger;
}
