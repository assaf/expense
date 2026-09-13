import { ListChecks } from "lucide-react";
import type { ReactNode } from "react";
import { PageShell } from "~/components/PageShell";
import type { DropTarget } from "~/lib/use-drop-target";

/**
 * The reconcile page chrome, shared by the landing and the run view so its
 * layout lives in one place. The landing hands it a drop target: a statement
 * dropped anywhere on the page is accepted, and the dashed outline wraps the
 * whole page the way the expense list's does.
 */
export function ReconcileShell({
  drop,
  children,
}: {
  drop?: DropTarget;
  children: ReactNode;
}) {
  return (
    <PageShell
      maxWidth="max-w-4xl"
      icon={<ListChecks aria-hidden="true" className="h-6 w-6" />}
      title="Reconcile"
      drop={drop}
    >
      {children}
    </PageShell>
  );
}
