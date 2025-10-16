/**
 * Detection Result Cache
 * 
 * LRU cache with TTL for authentication detection results.
 * Provides significant performance improvements for repeated URL requests.
 * 
 */

import { LRUCache } from 'lru-cache';
import { logger } from './logger';
import type { DetectionResult } from '@/lib/types/auth.types';

/*============================================================================*
 * CONFIGURATION
 *============================================================================*/

export const CACHE_CONFIG = {
  /**
   * Maximum number of cached entries
   * 1000 entries × ~5KB per entry = ~5MB memory usage
   */
  MAX_SIZE: 1000,

  /**
   * Default TTL (Time-To-Live) in milliseconds
   * 24 hours = Auth methods rarely change within a day
   */
  DEFAULT_TTL: 24 * 60 * 60 * 1000, // 24 hours


  TTL_BY_DOMAIN: {
    localhost: 5 * 60 * 1000, 
    '127.0.0.1': 5 * 60 * 1000, 
  } as Record<string, number>,

  CACHE_EMPTY_RESULTS: true,


  CACHE_PATTERN_RESULTS: true,


  PATTERN_RESULT_TTL: null as number | null,

  ENABLE_STATS: true,


  LOG_CACHE_OPERATIONS: true,
} as const;

/*============================================================================*
 * TYPE DEFINITIONS
 *============================================================================*/

interface CachedDetectionResult extends DetectionResult {
  cachedAt: number;
  expiresAt: number;
}

export interface CacheStats {
  totalRequests: number;
  cacheHits: number;
  cacheMisses: number;
  hitRate: string;
  currentSize: number;
  maxSize: number;
  memoryEstimate: string;
  oldestEntry: string | null;
  newestEntry: string | null;
}

/*============================================================================*
 * CACHE CLASS
 *============================================================================*/

class DetectionCache {
  private cache: LRUCache<string, CachedDetectionResult>;
  private stats = {
    hits: 0,
    misses: 0,
  };

  constructor() {
    this.cache = new LRUCache<string, CachedDetectionResult>({
      max: CACHE_CONFIG.MAX_SIZE,
      ttl: CACHE_CONFIG.DEFAULT_TTL,
      
      // Update age on get (LRU behavior)
      updateAgeOnGet: true,
      
      // Allow stale entries while fetching new data
      allowStale: false,
    });

    logger.info('SYSTEM', 'CACHE_INITIALIZED', {
      maxSize: CACHE_CONFIG.MAX_SIZE,
      defaultTTL: `${CACHE_CONFIG.DEFAULT_TTL / 1000}s`,
    });
  }

  /**
   * Normalize URL to create consistent cache key
   * 
   * Removes:
   * - Query parameters (auth pages usually don't depend on them)
   * - URL fragments (#section)
   * - Trailing slashes
   * - www prefix (optional)
   * 
   * Examples:
   * - https://github.com/login?redirect=home → https://github.com/login
   * - https://www.example.com/auth/ → https://example.com/auth
   */
  private normalizeURL(url: string): string {
    try {
      const parsed = new URL(url);
      
      const hostname = parsed.hostname.replace(/^www\./, '');
      
      let normalized = `${parsed.protocol}//${hostname}${parsed.pathname}`;
      
      if (normalized.endsWith('/') && normalized !== `${parsed.protocol}//${hostname}/`) {
        normalized = normalized.slice(0, -1);
      }
      
      return normalized;
    } catch (error) {
      logger.warn('CACHE', 'URL_NORMALIZATION_FAILED', 'Invalid URL format', {
        url,
        error: error instanceof Error ? error.message : String(error),
      });
      return url;
    }
  }

  /**
   * Get custom TTL for specific domain
   */
  private getTTL(url: string, detectionMethod?: 'ai' | 'pattern' | 'hybrid' | 'none'): number {
    try {
      const parsed = new URL(url);
      const hostname = parsed.hostname.replace(/^www\./, '');
      
      // Check if domain has custom TTL
      if (CACHE_CONFIG.TTL_BY_DOMAIN[hostname]) {
        return CACHE_CONFIG.TTL_BY_DOMAIN[hostname];
      }
      
      // Use shorter TTL for pattern results (if configured)
      if (detectionMethod === 'pattern' && CACHE_CONFIG.PATTERN_RESULT_TTL !== null) {
        return CACHE_CONFIG.PATTERN_RESULT_TTL;
      }
      
      return CACHE_CONFIG.DEFAULT_TTL;
    } catch {
      return CACHE_CONFIG.DEFAULT_TTL;
    }
  }

  /**
   * Get cached detection result
   * 
   * Returns null if:
   * - Entry not in cache
   * - Entry expired
   * - Cache disabled
   */
  get(url: string, requestId: string): DetectionResult | null {
    const cacheKey = this.normalizeURL(url);
    const cached = this.cache.get(cacheKey);

    if (cached) {
      this.stats.hits++;
      
      if (CACHE_CONFIG.LOG_CACHE_OPERATIONS) {
        logger.success(requestId, 'CACHE_HIT', {
          url: cacheKey,
          cachedAt: new Date(cached.cachedAt).toISOString(),
          age: `${Math.round((Date.now() - cached.cachedAt) / 1000)}s`,
          detectionMethod: cached.detectionMethod,
          componentCount: cached.components.length,
        });
      }

      // Return result without cache metadata
      const { cachedAt, expiresAt, ...result } = cached;
      return result;
    }

    this.stats.misses++;
    
    if (CACHE_CONFIG.LOG_CACHE_OPERATIONS) {
      logger.info(requestId, 'CACHE_MISS', {
        url: cacheKey,
      });
    }

    return null;
  }

  /**
   * Store detection result in cache
   * 
   * Skips caching if:
   * - Result indicates failure (success: false)
   * - Empty results and CACHE_EMPTY_RESULTS is false
   * - Pattern results and CACHE_PATTERN_RESULTS is false
   */
  set(url: string, result: DetectionResult, requestId: string): void {
    // Don't cache failed detections
    if (!result.success) {
      logger.info(requestId, 'CACHE_SKIP_FAILED', {
        url,
        reason: 'Detection failed',
      });
      return;
    }

    if (!result.found && !CACHE_CONFIG.CACHE_EMPTY_RESULTS) {
      logger.info(requestId, 'CACHE_SKIP_EMPTY', {
        url,
        reason: 'No auth found and CACHE_EMPTY_RESULTS is false',
      });
      return;
    }

    if (result.detectionMethod === 'pattern' && !CACHE_CONFIG.CACHE_PATTERN_RESULTS) {
      logger.info(requestId, 'CACHE_SKIP_PATTERN', {
        url,
        reason: 'Pattern result and CACHE_PATTERN_RESULTS is false',
      });
      return;
    }

    const cacheKey = this.normalizeURL(url);
    const ttl = this.getTTL(url, result.detectionMethod);
    const now = Date.now();

    const cachedResult: CachedDetectionResult = {
      ...result,
      cachedAt: now,
      expiresAt: now + ttl,
    };

    this.cache.set(cacheKey, cachedResult, { ttl });

    if (CACHE_CONFIG.LOG_CACHE_OPERATIONS) {
      logger.success(requestId, 'CACHE_SET', {
        url: cacheKey,
        ttl: `${Math.round(ttl / 1000)}s`,
        expiresAt: new Date(cachedResult.expiresAt).toISOString(),
        detectionMethod: result.detectionMethod,
        componentCount: result.components.length,
        cacheSize: this.cache.size,
      });
    }
  }

  /**
   * Check if URL is in cache (without retrieving)
   */
  has(url: string): boolean {
    const cacheKey = this.normalizeURL(url);
    return this.cache.has(cacheKey);
  }

  /**
   * Remove specific URL from cache
   */
  delete(url: string, requestId: string): boolean {
    const cacheKey = this.normalizeURL(url);
    const deleted = this.cache.delete(cacheKey);

    if (deleted) {
      logger.info(requestId, 'CACHE_INVALIDATED', {
        url: cacheKey,
      });
    }

    return deleted;
  }

  /**
   * Clear entire cache
   */
  clear(requestId: string): void {
    const previousSize = this.cache.size;
    this.cache.clear();
    this.stats.hits = 0;
    this.stats.misses = 0;

    logger.info(requestId, 'CACHE_CLEARED', {
      entriesCleared: previousSize,
    });
  }

  /**
   * Get cache statistics
   */
  getStats(): CacheStats {
    const totalRequests = this.stats.hits + this.stats.misses;
    const hitRate = totalRequests > 0 
      ? `${Math.round((this.stats.hits / totalRequests) * 100)}%`
      : '0%';

    // Estimate memory usage (rough estimate: 5KB per entry)
    const memoryEstimate = `${Math.round((this.cache.size * 5) / 1024)}MB`;

    // Find oldest and newest entries
    let oldestEntry: string | null = null;
    let newestEntry: string | null = null;
    let oldestTime = Infinity;
    let newestTime = 0;

    for (const [, value] of this.cache.entries()) {
      if (value.cachedAt < oldestTime) {
        oldestTime = value.cachedAt;
        oldestEntry = new Date(value.cachedAt).toISOString();
      }
      if (value.cachedAt > newestTime) {
        newestTime = value.cachedAt;
        newestEntry = new Date(value.cachedAt).toISOString();
      }
    }

    return {
      totalRequests,
      cacheHits: this.stats.hits,
      cacheMisses: this.stats.misses,
      hitRate,
      currentSize: this.cache.size,
      maxSize: CACHE_CONFIG.MAX_SIZE,
      memoryEstimate,
      oldestEntry,
      newestEntry,
    };
  }
}

/*============================================================================*
 * SINGLETON EXPORT
 *============================================================================*/

/**
 * Singleton instance of detection cache
 * Shared across all requests in the application
 */
export const detectionCache = new DetectionCache();

