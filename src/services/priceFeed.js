/**
 * KLIK Price Feed Service
 *
 * Fetches KLIK/USD price from Jupiter API with caching and fallback.
 */

const KLIK_MINT = process.env.KLIK_TOKEN_MINT || '8cPAhMb6bvQg3v1v3yxBCLnUJkboEiV2F8W19z1CS5iB';
const JUPITER_API = 'https://price.jup.ag/v6/price';
const COINGECKO_SOL = 'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd';

let cachedPrice = null;
let lastFetch = 0;
const CACHE_TTL = 60 * 1000; // 60 seconds

/**
 * Get current KLIK price in USD
 * @returns {Promise<{klikUsd: number, klikSol?: number, solUsd?: number, updatedAt: string, source: string}>}
 */
export async function getKlikPrice() {
  const now = Date.now();
  if (cachedPrice && now - lastFetch < CACHE_TTL) {
    return cachedPrice;
  }

  try {
    // Primary: Jupiter Price API
    const jupRes = await fetch(`${JUPITER_API}?ids=${KLIK_MINT}`, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(5000)
    });

    if (!jupRes.ok) {
      throw new Error(`Jupiter API returned ${jupRes.status}`);
    }

    const jupData = await jupRes.json();
    const klikData = jupData?.data?.[KLIK_MINT];

    if (klikData?.price && klikData.price > 0) {
      cachedPrice = {
        klikUsd: klikData.price,
        solUsd: null,
        klikSol: null,
        updatedAt: new Date().toISOString(),
        source: 'jupiter'
      };

      // Get SOL/USD for reference (optional)
      try {
        const solRes = await fetch(COINGECKO_SOL, {
          signal: AbortSignal.timeout(3000)
        });
        if (solRes.ok) {
          const solData = await solRes.json();
          cachedPrice.solUsd = solData?.solana?.usd || null;
          if (cachedPrice.solUsd > 0) {
            cachedPrice.klikSol = cachedPrice.klikUsd / cachedPrice.solUsd;
          }
        }
      } catch (e) {
        // SOL price is optional, don't fail if unavailable
      }

      lastFetch = now;
      return cachedPrice;
    }
  } catch (err) {
    console.error('Jupiter price fetch failed:', err.message);
  }

  // Fallback: return last cached or zeros
  return cachedPrice || {
    klikUsd: 0,
    klikSol: 0,
    solUsd: 0,
    updatedAt: new Date().toISOString(),
    source: 'cache_fallback'
  };
}

/**
 * Start background price refresh
 * @param {import('redis').RedisClientType} redis - Redis client for caching
 */
export function startPriceRefresh(redis) {
  const refresh = async () => {
    try {
      const price = await getKlikPrice();
      if (redis && price) {
        await redis.set('klik:price', JSON.stringify(price), { EX: 120 });
      }
    } catch (err) {
      console.error('Price refresh error:', err.message);
    }
  };

  // Immediate first fetch
  refresh();

  // Schedule periodic refresh
  setInterval(refresh, CACHE_TTL);
  console.log('Price feed refresh started (60s interval)');
}

/**
 * Get cached price from Redis (for fast reads)
 * @param {import('redis').RedisClientType} redis
 */
export async function getCachedPrice(redis) {
  if (redis) {
    try {
      const cached = await redis.get('klik:price');
      if (cached) {
        return JSON.parse(cached);
      }
    } catch (e) {
      // Fall through to fetch
    }
  }
  return getKlikPrice();
}
