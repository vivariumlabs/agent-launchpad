// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Adapted from pons-labs (MIT): contractsV2/src/v2/PonsV2GraduationGuard.sol
// (ported from a standalone contract to an internal library — the launchpad runs the
//  preflight inside AgentFactory rather than through an external guard contract.)

import {Pool} from "@uniswap/v4-core/src/libraries/Pool.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";

import {GraduationMath} from "./GraduationMath.sol";

/**
 * @title GraduationChecks
 * @notice Stateless preflight for a graduation's Uniswap v4 seed. It models the rejections of
 * the real mint so a graduation can never drain its curve into a seed that v4 core would
 * refuse.
 *
 * @dev Phase one of graduation is irreversible: it marks the curve graduated and moves its
 * reserves to the factory. A seed that passes here and reverts inside v4 would leave the agent
 * permanently unseedable — and, unlike PONS, this launchpad has no owner rescue path. The
 * preflight therefore has to mirror the whole downstream call graph, not just field widths,
 * and is run twice: once on the projected amounts before the sweep, and again on the real
 * amounts before the pool is created.
 */
library GraduationChecks {
    /**
     * @dev v4 carries pool balance changes in a `BalanceDelta` whose halves are `int128`, and
     * `Pool.modifyLiquidity` narrows each side with `SafeCast.toInt128`. The signed bound is
     * the real one, so an amount above it reverts inside core however it was passed in.
     */
    uint256 internal constant MAX_SEED_AMOUNT = uint256(uint128(type(int128).max));

    error SqrtPriceOutOfBounds();
    error GraduationSeedNotViable();

    /**
     * @notice Verifies a pool of these amounts can be initialized and seeded with a nonzero,
     *         full-range position without lossy amount narrowing.
     * @param tickSpacing Pool tick spacing the position spans.
     * @param amount0 Seed amount of the pool's currency0 (already sorted by the caller).
     * @param amount1 Seed amount of the pool's currency1 (already sorted by the caller).
     */
    function assertSeedable(int24 tickSpacing, uint256 amount0, uint256 amount1) internal pure {
        if (amount0 > MAX_SEED_AMOUNT || amount1 > MAX_SEED_AMOUNT) revert GraduationSeedNotViable();

        uint160 sqrtPriceX96 = GraduationMath.sqrtPriceX96FromAmounts(amount0, amount1);
        if (sqrtPriceX96 <= TickMath.MIN_SQRT_PRICE || sqrtPriceX96 >= TickMath.MAX_SQRT_PRICE) {
            revert SqrtPriceOutOfBounds();
        }

        (int24 tickLower, int24 tickUpper) = fullRangeTicks(tickSpacing);
        uint128 liquidity = LiquidityAmounts.getLiquidityForAmounts(
            sqrtPriceX96,
            TickMath.getSqrtPriceAtTick(tickLower),
            TickMath.getSqrtPriceAtTick(tickUpper),
            amount0,
            amount1
        );
        // The seed mint initializes both boundary ticks, so the position's own liquidity is the
        // entire `liquidityGross` at each of them. v4 reverts `TickLiquidityOverflow` once a
        // tick's gross liquidity passes the cap its spacing implies — an independent rejection
        // from the amount bounds above.
        if (liquidity == 0 || liquidity > Pool.tickSpacingToMaxLiquidityPerTick(tickSpacing)) {
            revert GraduationSeedNotViable();
        }
    }

    /// @notice v4's usable full-range ticks for `tickSpacing` (±887220 at spacing 60).
    /// @dev Truncation toward zero is what derives the usable boundary ticks; do not "fix" it.
    function fullRangeTicks(int24 tickSpacing) internal pure returns (int24 tickLower, int24 tickUpper) {
        tickLower = TickMath.minUsableTick(tickSpacing);
        tickUpper = TickMath.maxUsableTick(tickSpacing);
    }
}
