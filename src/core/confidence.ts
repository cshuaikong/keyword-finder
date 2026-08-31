import type { ValidationDimension, ValidationEvidence } from './plugin.js';

/** 固定权重避免“只有一个成功维度”被错误归一化成高置信度。 */
const DIMENSION_WEIGHTS: Record<ValidationDimension, number> = {
  volume: 0.40,
  competition: 0.25,
  domain: 0.25,
  translation: 0.10,
};

export interface ConfidenceResult {
  score: number;
  level: 'low' | 'medium' | 'high';
}

export function calculateConfidence(evidence: ValidationEvidence[]): ConfidenceResult {
  const latest = new Map<ValidationDimension, ValidationEvidence>();
  const latestUsable = new Map<ValidationDimension, ValidationEvidence>();
  for (const item of evidence) {
    const previous = latest.get(item.dimension);
    if (!previous || item.checkedAt.getTime() >= previous.checkedAt.getTime()) {
      latest.set(item.dimension, item);
    }
    const previousUsable = latestUsable.get(item.dimension);
    if (item.status !== 'failed' && (!previousUsable || item.checkedAt.getTime() >= previousUsable.checkedAt.getTime())) {
      latestUsable.set(item.dimension, item);
    }
  }

  let score = 0;
  let hasUnresolvedFailure = false;
  for (const [dimension, weight] of Object.entries(DIMENSION_WEIGHTS) as Array<[ValidationDimension, number]>) {
    const latestItem = latest.get(dimension);
    const item = latestUsable.get(dimension) ?? latestItem;
    if (!item) continue;
    const freshnessAge = Date.now() - item.checkedAt.getTime();
    const freshnessFactor = freshnessAge > 30 * 24 * 3600 * 1000 ? 0.7 : 1;
    const failedAfterUsable = latestItem?.status === 'failed'
      && latestItem.checkedAt.getTime() >= item.checkedAt.getTime();
    if (failedAfterUsable) hasUnresolvedFailure = true;
    const failureFactor = failedAfterUsable && item.status !== 'failed' ? 0.5 : 1;
    score += Math.min(Math.max(item.confidence, 0), 100) * weight * freshnessFactor * failureFactor;
  }

  // 任一维度当前验证失败时，不允许进入高置信度自动决策。
  const rounded = Math.min(Math.round(score), hasUnresolvedFailure ? 69 : 100);
  return {
    score: rounded,
    level: rounded >= 75 ? 'high' : rounded >= 45 ? 'medium' : 'low',
  };
}
