// The badge catalog shown to the user. Badges are awarded only by sync_badges in the
// database; this module only mirrors the thresholds and builds labels and the badge board.
// Pure (no astro:env), so Vitest imports it directly.

// Mirrors sync_badges in supabase/migrations/20261031120000_badges.sql; change both together.
export const STREAK_THRESHOLDS = [3, 7, 30, 100] as const;
// Mirrors sync_badges in supabase/migrations/20261031120000_badges.sql; change both together.
export const MASTERED_CARD_THRESHOLDS = [10, 50, 100, 250] as const;

export type BadgeKind = "streak" | "mastered_cards" | "topic";

// One earned badge. threshold is null for a topic badge; topicId/topicName are null for the
// threshold badges.
export interface EarnedBadge {
  kind: BadgeKind;
  threshold: number | null;
  topicId: string | null;
  topicName: string | null;
  topicArchived: boolean;
  awardedAt: string;
}

// badge_overview(): the current progress and every earned badge, oldest first.
export interface BadgeOverview {
  streakDays: number;
  masteredCards: number;
  earned: EarnedBadge[];
}

// One threshold badge on the board, earned or not; progress is capped at the threshold.
export interface ThresholdBadgeRow {
  kind: "streak" | "mastered_cards";
  threshold: number;
  label: string;
  earned: boolean;
  awardedAt?: string;
  progress: string;
}

export interface BadgeBoard {
  streak: ThresholdBadgeRow[];
  masteredCards: ThresholdBadgeRow[];
  // Earned topic badges only, oldest first.
  topics: EarnedBadge[];
}

// "1 dzień", every other count "dni" (also used by streakLabel).
export function daysLabel(days: number): string {
  return `${days} ${days === 1 ? "dzień" : "dni"}`;
}

// "1 opanowana fiszka", "2 opanowane fiszki", "50 opanowanych fiszek".
function masteredCardsLabel(count: number): string {
  if (count === 1) return "1 opanowana fiszka";
  const lastDigit = count % 10;
  const lastTwo = count % 100;
  const few = lastDigit >= 2 && lastDigit <= 4 && (lastTwo < 12 || lastTwo > 14);
  return `${count} ${few ? "opanowane fiszki" : "opanowanych fiszek"}`;
}

export function badgeLabel(badge: Pick<EarnedBadge, "kind" | "threshold" | "topicName">): string {
  if (badge.kind === "streak") return `Seria ${daysLabel(badge.threshold ?? 0)}`;
  if (badge.kind === "mastered_cards") return masteredCardsLabel(badge.threshold ?? 0);
  return badge.topicName ? `Temat opanowany: ${badge.topicName}` : "Temat opanowany";
}

function thresholdRows(
  kind: "streak" | "mastered_cards",
  thresholds: readonly number[],
  current: number,
  earned: EarnedBadge[],
): ThresholdBadgeRow[] {
  return thresholds.map((threshold) => {
    // A badge is never taken away: it stays earned when the current state drops below it.
    const badge = earned.find((item) => item.kind === kind && item.threshold === threshold);
    const shown = badge ? threshold : Math.min(Math.max(current, 0), threshold);
    return {
      kind,
      threshold,
      label: badgeLabel({ kind, threshold, topicName: null }),
      earned: badge !== undefined,
      ...(badge ? { awardedAt: badge.awardedAt } : {}),
      progress: `${shown}/${threshold}`,
    };
  });
}

// Every threshold badge with its status and progress, plus the earned topic badges.
export function badgeBoard(overview: BadgeOverview): BadgeBoard {
  return {
    streak: thresholdRows("streak", STREAK_THRESHOLDS, overview.streakDays, overview.earned),
    masteredCards: thresholdRows("mastered_cards", MASTERED_CARD_THRESHOLDS, overview.masteredCards, overview.earned),
    topics: overview.earned.filter((badge) => badge.kind === "topic"),
  };
}
