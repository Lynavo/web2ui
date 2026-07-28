/**
 * Central registry for decision thresholds in the conversion layer (Phase 6).
 *
 * Rules:
 * - This file contains only decision thresholds: comparison values that change
 *   structural decisions. Pure geometry constants (gradient matrix 0.5,
 *   rounding precision, minimum size 0.01) do not belong here.
 * - Every threshold must state what it decides, why the value was selected,
 *   and which fallback path it activates.
 * - New decision thresholds must be registered here and reproduced by a
 *   fixture instead of being scattered through implementation code.
 */

/**
 * Single-line text height correction window. When the styled line height is
 * approximately the font size (<= 1.02x) while the captured height is slightly
 * larger (1.05x to 1.55x), treat it as a browser `normal` line-height mismatch
 * and use the captured height. Outside this window, keep the styled line height.
 */
export const SINGLE_LINE_STYLE_HEIGHT_RATIO_MAX = 1.02;
export const SINGLE_LINE_CAPTURED_MIN_RATIO = 1.05;
export const SINGLE_LINE_CAPTURED_MAX_RATIO = 1.55;

/** Line-height fallback: use fontSize x 1.2 when no reliable value exists. */
export const FALLBACK_LINE_HEIGHT_RATIO = 1.2;

/**
 * Near-square decision: treat a box as square when the width/height difference
 * is at most 0.02 of the longer edge (used for corner-radius handling).
 */
export const NEAR_SQUARE_TOLERANCE = 0.02;
