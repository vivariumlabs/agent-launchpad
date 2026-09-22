// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Adapted from pons-labs (MIT): contractsV2/src/v2/libraries/PonsV2GraduationMath.sol

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";

/**
 * @title GraduationMath
 * @notice Derives the `sqrtPriceX96` a brand-new Uniswap v4 pool must open at so a single
 * full-range position of two known amounts sits exactly at spot.
 *
 * @dev In the full-range limit (tickLower/tickUpper at the usable min/max ticks) a position's
 * amount0 and amount1 approach `liquidity / sqrtPrice` and `liquidity * sqrtPrice`, so
 * `amount1 / amount0` converges to the pool price. That is exact enough for seeding a
 * graduation pool: both amounts are a bonding curve's real, non-extreme final reserves.
 */
library GraduationMath {
    error ZeroAmount();
    error UnsupportedPrice();

    /**
     * @notice Computes `sqrtPriceX96 = sqrt(amount1 / amount0) * 2**96`.
     * @param amount0 Amount of the pool's currency0, must be nonzero.
     * @param amount1 Amount of the pool's currency1, must be nonzero.
     */
    function sqrtPriceX96FromAmounts(uint256 amount0, uint256 amount1) internal pure returns (uint160) {
        if (amount0 == 0 || amount1 == 0) revert ZeroAmount();

        if (_fitsQ192(amount0, amount1)) {
            uint256 ratioX192 = FullMath.mulDiv(amount1, 1 << 192, amount0);
            return uint160(Math.sqrt(ratioX192));
        }

        // A Q128 ratio preserves the remaining valid v4 price range without requiring the
        // intermediate Q192 quotient to fit in uint256.
        if (!_fitsQ128(amount0, amount1)) revert UnsupportedPrice();
        uint256 ratioX128 = FullMath.mulDiv(amount1, 1 << 128, amount0);
        uint256 sqrtPriceX64 = Math.sqrt(ratioX128);
        if (sqrtPriceX64 > type(uint128).max) revert UnsupportedPrice();

        // sqrt(amount1 / amount0 * 2**128) is Q64. Shift it into Q96.
        return uint160(sqrtPriceX64 << 32);
    }

    /**
     * @dev A Q192 quotient fits uint256 only when `amount1 / amount0` is strictly below 2**64.
     * Avoiding the multiplication also avoids overflow.
     */
    function _fitsQ192(uint256 amount0, uint256 amount1) private pure returns (bool) {
        if (amount0 > type(uint192).max) return true;
        return amount1 < (amount0 << 64);
    }

    /// @dev A Q128 quotient covers v4's remaining representable price range.
    function _fitsQ128(uint256 amount0, uint256 amount1) private pure returns (bool) {
        if (amount0 > type(uint128).max) return true;
        return amount1 < (amount0 << 128);
    }
}
