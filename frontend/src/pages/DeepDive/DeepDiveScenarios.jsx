import { useSearchParams } from "react-router-dom";
import { PageHeader } from "../../components/ui/PageHeader.jsx";
import { PageIcons } from "../../components/ui/PageIcons.jsx";
import { EmptyState } from "../../components/ui/EmptyState.jsx";

/**
 * Deep Dive & Scenarios — chat + scenario simulation surface.
 *
 * Replaces Asset Hub and Compass AI / Advisor. Reachable two ways:
 *   - standalone, no params: freeform chat, name any ticker/strategy yourself
 *   - pre-seeded: /research/deep-dive?recommendationId=<id>, context pre-loaded
 *     from an Opportunity Engine card
 *
 * The real chat + simulate_scenario/approve_scenario tool-use lands in a
 * later phase of the agentic rebuild; this page is the routed,
 * permission-gated shell (including both entry paths) so the nav
 * consolidation can ship independently of that backend work.
 */
export default function DeepDiveScenarios() {
  const [searchParams] = useSearchParams();
  const recommendationId = searchParams.get("recommendationId");

  return (
    <div className="flex flex-col gap-6 p-6 max-w-7xl mx-auto">
      <PageHeader
        title="Deep Dive & Scenarios"
        icon={PageIcons.deepDive}
        subtitle="Ask about any position or ticker, or dig into a recommendation — run scenarios and see the probability-weighted outcome before deciding."
      />
      <EmptyState
        type="empty"
        message={
          recommendationId
            ? `This chat is being rebuilt as part of the agentic rebuild — once online, it'll open straight into recommendation ${recommendationId} with full context pre-loaded.`
            : "This chat is being rebuilt as part of the agentic rebuild — standalone deep dives on any ticker or strategy will be available here once it's online."
        }
      />
    </div>
  );
}
