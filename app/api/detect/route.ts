import { NextResponse } from 'next/server';
import { scrapeWebsite } from '@/lib/scraper';
import { detectAuthentication } from '@/lib/detector';
import { logger } from '@/lib/logger';
import { browserPool } from '@/lib/browser-pool';
import { detectionCache } from '@/lib/cache';

/**
 * API Route: POST /api/detect
 * 
 * Detects authentication components on a website using AI
 * 
 * Request body:
 * {
 *   "url": "https://example.com"
 * }
 * 
 * Response:
 * {
 *   "success": true,
 *   "found": true,
 *   "components": [...],
 *   "pageTitle": "...",
 *   "screenshot": "data:image/jpeg;base64,...",
 *   "detectionMethod": "ai"
 * }
 */
const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

export async function POST(request: Request) {
  const requestId = Math.random().toString(36).substring(7);
  const startTime = Date.now();

  try {
    const { url } = await request.json();

    /**
     * Validate URL
     */
    if (!url) {
      const res = NextResponse.json({ error: 'URL is required' }, { status: 400 });
      Object.entries(corsHeaders).forEach(([k, v]) => res.headers.set(k, v));
      return res;
    }

    logger.info(requestId, 'API_REQUEST_START', { url });

    /**
     * Check cache first (99%+ faster for cache hits)
     */
    const cachedResult = detectionCache.get(url, requestId);
    if (cachedResult) {
      logger.success(requestId, 'API_REQUEST_SUCCESS_CACHED', {
        found: cachedResult.found,
        componentCount: cachedResult.components.length,
        detectionMethod: cachedResult.detectionMethod,
        duration: `${Date.now() - startTime}ms`,
        cached: true,
      }, startTime);

      const res = NextResponse.json({
        ...cachedResult,
        cached: true,
      });
      Object.entries(corsHeaders).forEach(([k, v]) => res.headers.set(k, v));
      return res;
    }

    /**
     * Step 1: Scrape website (get HTML + screenshot + live page)
     */
    const scrapeResult = await scrapeWebsite(url, requestId);

    if (!scrapeResult.success || !scrapeResult.html || !scrapeResult.page) {
      const res = NextResponse.json(
        { success: false, error: scrapeResult.error || 'Failed to scrape website' },
        { status: 500 }
      );
      Object.entries(corsHeaders).forEach(([k, v]) => res.headers.set(k, v));
      return res;
    }

    try {
      /**
       * Step 2: Detect authentication components
       * 
       * Pass:
       * - HTML (for AI analysis)
       * - Screenshot (for visual context)
       * - Live page (for Playwright extraction)
       */
      const detectionResult = await detectAuthentication(
        scrapeResult.html,
        url,
        scrapeResult.screenshot,
        scrapeResult.page,
        requestId
      );

      logger.success(
        requestId,
        'API_REQUEST_SUCCESS',
        {
          found: detectionResult.found,
          componentCount: detectionResult.components.length,
          detectionMethod: detectionResult.detectionMethod,
          duration: `${Date.now() - startTime}ms`,
        },
        startTime
      );

      /**
       * Cache the detection result for future requests
       */
      detectionCache.set(url, detectionResult, requestId);

      /**
       * Return successful detection result
       */
      const res = NextResponse.json({
        ...detectionResult,
        pageTitle: scrapeResult.title,
        screenshot: scrapeResult.screenshot,
        cached: false,
      });
      Object.entries(corsHeaders).forEach(([k, v]) => res.headers.set(k, v));
      return res;
    } finally {
      if (scrapeResult.page) {
        try {
          await scrapeResult.page.close();
          logger.info(requestId, 'API_CLEANUP_PAGE_CLOSED', {
            message: 'Page closed after detection',
          });
        } catch (closeError) {
          logger.warn(
            requestId,
            'API_CLEANUP_PAGE_CLOSE_ERROR',
            'Failed to close page',
            {
              error:
                closeError instanceof Error
                  ? closeError.message
                  : String(closeError),
            }
          );
        }
      }

      if (scrapeResult.context) {
        await browserPool.closeContext(scrapeResult.context, requestId);
      }
    }
  } catch (error) {
    logger.error(requestId, 'API_REQUEST_ERROR', error as Error);

    const res = NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Internal server error',
      },
      { status: 500 }
    );
    Object.entries(corsHeaders).forEach(([k, v]) => res.headers.set(k, v));
    return res;
  }
}

/**
 * Health check endpoint + Cache statistics
 * 
 * GET /api/detect - Returns service status and cache stats
 * GET /api/detect?stats=true - Returns detailed cache statistics
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const showStats = searchParams.get('stats') === 'true';

  if (showStats) {
    const stats = detectionCache.getStats();
    const res = NextResponse.json({
      status: 'ok',
      service: 'auth-component-detector',
      version: '2.0.0',
      cache: stats,
    });
    Object.entries(corsHeaders).forEach(([k, v]) => res.headers.set(k, v));
    return res;
  }

  const res = NextResponse.json({
    status: 'ok',
    service: 'auth-component-detector',
    version: '2.0.0',
  });
  Object.entries(corsHeaders).forEach(([k, v]) => res.headers.set(k, v));
  return res;
}

/**
 * Cache management endpoint
 * 
 * DELETE /api/detect - Clear entire cache or invalidate specific URL
 * DELETE /api/detect?url=https://example.com - Invalidate specific URL
 */
export async function DELETE(request: Request) {
  const requestId = Math.random().toString(36).substring(7);
  const { searchParams } = new URL(request.url);
  const url = searchParams.get('url');

  if (url) {
    // Invalidate specific URL
    const deleted = detectionCache.delete(url, requestId);
    const res = NextResponse.json({
      success: true,
      action: 'invalidate',
      url,
      deleted,
    });
    Object.entries(corsHeaders).forEach(([k, v]) => res.headers.set(k, v));
    return res;
  } else {
    // Clear entire cache
    detectionCache.clear(requestId);
    const res = NextResponse.json({
      success: true,
      action: 'clear',
      message: 'Cache cleared successfully',
    });
    Object.entries(corsHeaders).forEach(([k, v]) => res.headers.set(k, v));
    return res;
  }
}