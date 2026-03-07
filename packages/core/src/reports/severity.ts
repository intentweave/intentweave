/**
 * Severity and Action Scoring
 * 
 * Deterministic rules for computing issue severity and action ranking.
 * See docs/REPORTING-SPEC.md sections 6-7.
 */

import type { 
  Issue, 
  IssueSeverity, 
  IssueKind,
  ReportPolicy,
  SuggestedAction,
} from './types.js';

// =============================================================================
// Severity Computation
// =============================================================================

/**
 * Compute issue severity based on deterministic rules.
 * 
 * Blocker:
 * - Any contradiction with confidence >= blockerConfidence
 * - Any error that breaks pipeline stage (stageBreaking=true)
 * - Any open_end where mustHave=true AND confidence >= 0.85
 * 
 * Warning:
 * - needs_review with confidence >= warningConfidence
 * - open_end with confidence in [warningConfidence, 0.85)
 * - contradiction with confidence in [warningConfidence, blockerConfidence)
 * 
 * Info:
 * - Low confidence items (< warningConfidence)
 * - Purely advisory items
 */
export function computeSeverity(
  kind: IssueKind,
  confidence: number,
  policy: ReportPolicy,
  options?: {
    stageBreaking?: boolean;
    mustHave?: boolean;
  }
): IssueSeverity {
  const { blockerConfidence, warningConfidence } = policy;
  const { stageBreaking, mustHave } = options ?? {};
  
  // Blocker conditions
  if (kind === 'error' && stageBreaking) {
    return 'blocker';
  }
  if (kind === 'contradiction' && confidence >= blockerConfidence) {
    return 'blocker';
  }
  if (kind === 'open_end' && mustHave && confidence >= 0.85) {
    return 'blocker';
  }
  
  // Warning conditions
  if (confidence >= warningConfidence) {
    return 'warning';
  }
  
  return 'info';
}

// =============================================================================
// Action Scoring
// =============================================================================

const SEVERITY_WEIGHTS: Record<IssueSeverity, number> = {
  blocker: 3,
  warning: 2,
  info: 1,
};

const IMPACT_WEIGHTS: Record<IssueKind, number> = {
  contradiction: 3,
  error: 3,
  open_end: 2,
  needs_review: 1,
};

/**
 * Parse effort string to numeric weight.
 * 
 * Examples:
 * - "2h" -> 1
 * - "4h" -> 2
 * - "0.5d" -> 1
 * - "1d" -> 2
 * - "2d" -> 4
 */
export function parseEffort(effort?: string): number {
  if (!effort) return 2; // default
  
  const value = parseFloat(effort);
  if (isNaN(value)) return 2;
  
  if (effort.includes('h')) {
    // Hours: 2h=1, 4h=2, 8h=4
    return Math.max(1, value / 2);
  }
  if (effort.includes('d')) {
    // Days: 0.5d=1, 1d=2, 2d=4
    return value * 2;
  }
  
  return 2;
}

/**
 * Compute action score for ranking.
 * 
 * score = (severityWeight × confidence × impactWeight) / effortWeight
 */
export function computeActionScore(
  action: Pick<SuggestedAction, 'estimatedEffort'>,
  issue?: Pick<Issue, 'severity' | 'confidence' | 'kind'>
): number {
  const severityWeight = SEVERITY_WEIGHTS[issue?.severity ?? 'info'];
  const confidenceWeight = issue?.confidence ?? 0.5;
  const impactWeight = IMPACT_WEIGHTS[issue?.kind ?? 'needs_review'];
  const effortWeight = parseEffort(action.estimatedEffort);
  
  return (severityWeight * confidenceWeight * impactWeight) / effortWeight;
}

/**
 * Rank and score a list of suggested actions.
 */
export function rankActions(
  actions: SuggestedAction[],
  issues: Issue[]
): SuggestedAction[] {
  // Create issue lookup
  const issueMap = new Map(issues.map(i => [i.id, i]));
  
  // Score all actions
  const scored = actions.map(action => {
    const issue = action.issueId ? issueMap.get(action.issueId) : undefined;
    const actionScore = computeActionScore(action, issue);
    return { ...action, actionScore };
  });
  
  // Sort by score descending
  scored.sort((a, b) => (b.actionScore ?? 0) - (a.actionScore ?? 0));
  
  // Assign ranks
  return scored.map((action, index) => ({
    ...action,
    rank: index + 1,
  }));
}
