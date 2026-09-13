import {
  ChartColumn,
  Download,
  ListChecks,
  Mail,
  Settings,
} from "lucide-react";
import type { ReactNode } from "react";

/**
 * The app's navigation destinations, in the order they render. The home
 * page header and the command palette's Navigate section both read this
 * list, so the two orders cannot drift: adding a destination or reordering
 * them is one edit here.
 */
export interface NavItem {
  /** Action id. It keys ACTION_SHORTCUTS (command-palette.tsx) for the
   * chord, and names the `data-shortcut` anchor the Shift+? hint layer
   * positions a badge on. */
  id:
    | "nav-insights"
    | "nav-emails"
    | "nav-reconcile"
    | "nav-reports"
    | "nav-settings";
  path: string;
  /** Header text, and the palette's action name behind "Go to". */
  label: string;
  /** Extra palette search terms beyond the label. */
  keywords: string;
  /** Rendered at 16px by both consumers. */
  icon: ReactNode;
}

export const NAV_ITEMS: NavItem[] = [
  {
    id: "nav-insights",
    path: "/insights",
    label: "Insights",
    keywords: "chart trends monthly ai",
    icon: <ChartColumn aria-hidden="true" className="h-4 w-4" />,
  },
  {
    id: "nav-emails",
    path: "/emails",
    label: "Email",
    keywords: "mail inbox emails fastmail gmail",
    icon: <Mail aria-hidden="true" className="h-4 w-4" />,
  },
  {
    id: "nav-reconcile",
    path: "/reconcile",
    label: "Reconcile",
    keywords: "statement credit card match",
    icon: <ListChecks aria-hidden="true" className="h-4 w-4" />,
  },
  {
    id: "nav-reports",
    path: "/export",
    label: "Reports",
    keywords: "export pdf download",
    icon: <Download aria-hidden="true" className="h-4 w-4" />,
  },
  {
    id: "nav-settings",
    path: "/settings",
    label: "Settings",
    keywords: "preferences account",
    icon: <Settings aria-hidden="true" className="h-4 w-4" />,
  },
];
