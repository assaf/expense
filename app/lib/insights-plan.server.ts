/**
 * What the chat's plan tools get from the request: the account to resolve
 * against, its plain report names, and the user's local date (the default
 * expense/trip date, since the server runs UTC: its own "today" is already
 * tomorrow for a west-coast evening).
 */
export interface PlanContext {
  accountId: string;
  reportNames: string[];
  today?: string;
}
