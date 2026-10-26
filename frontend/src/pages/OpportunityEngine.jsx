import { PageHeader } from "../components/ui/PageHeader.jsx";
import { PageIcons } from "../components/ui/PageIcons.jsx";
import { EmptyState } from "../components/ui/EmptyState.jsx";

/**
 * Opportunity Engine — scheduled + on-demand market scan.
 *
 * Replaces the old Wheel Scan page. The real scan (deterministic prefilter
 * across the stock universe -> Tower 1 portfolio/risk context -> Tower 2
 * AgentLoop ranking pass -> AgentRecommendations) lands in a later phase of
 * the agentic rebuild; this page is the routed, permission-gated shell for
 * it so the nav consolidation can ship independently of that backend work.
 */
export default function OpportunityEngine() {
  return (
    <div className="flex flex-col gap-6 p-6 max-w-7xl mx-auto">
      <PageHeader
        title="Opportunity Engine"
        icon={PageIcons.opportunityEngine}
        subtitle="Scans the market for long, short, and options setups ranked against your portfolio and risk profile."
      />
      <EmptyState
        type="empty"
        message="The scan engine is being rebuilt as part of the agentic rebuild — ranked recommendations will appear here once it's online."
      />
    </div>
  );
}
