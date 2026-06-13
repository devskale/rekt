import type { Strategy, StrategyConfig } from "./types.js";
import { LateScalpStrategy, type LateScalpConfig } from "./late-scalp.js";
import { SnipeStrategy } from "./snipe.js";
import { CoinFlipStrategy } from "./coin-flip.js";
import { MomentumStrategy } from "./momentum.js";

// ── Registry ────────────────────────────────────────────────────────

const strategies = new Map<string, Strategy>();

/**
 * Register a strategy. Overwrites if name already exists.
 */
export function registerStrategy(strategy: Strategy): void {
  strategies.set(strategy.config.name, strategy);
}

/**
 * Get all registered strategies.
 */
export function getStrategies(): Strategy[] {
  return [...strategies.values()];
}

/**
 * Get only enabled strategies.
 */
export function getEnabledStrategies(): Strategy[] {
  return [...strategies.values()].filter((s) => s.config.enabled);
}

/**
 * Get a strategy by config name.
 */
export function getStrategy(name: string): Strategy | undefined {
  return strategies.get(name);
}

/**
 * Toggle a strategy on/off by name.
 */
export function setStrategyEnabled(name: string, enabled: boolean): void {
  const s = strategies.get(name);
  if (s) s.config.enabled = enabled;
}

/**
 * Clear all registered strategies (useful for tests).
 */
export function clearStrategies(): void {
  strategies.clear();
}

// ── Pre-register all built-in strategies ────────────────────────────

export function registerDefaults(scalpConfig?: Partial<LateScalpConfig>): void {
  registerStrategy(new LateScalpStrategy(scalpConfig));
  registerStrategy(new SnipeStrategy());
  registerStrategy(new CoinFlipStrategy());
  registerStrategy(new MomentumStrategy());
}

// Auto-register on import with defaults
registerDefaults();
