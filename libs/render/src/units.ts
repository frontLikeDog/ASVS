import type { Unit } from './chrome';

/**
 * CSS length for a design unit. `u()` returns a plain number, which React only
 * converts to px for single-value style props. Inside a shorthand string such
 * as `padding: "57.6 84.48"` the unitless number is invalid CSS and the whole
 * declaration is dropped, so every string template must go through this.
 */
export function px(u: Unit, value: number): string {
  return `${u(value)}px`;
}
