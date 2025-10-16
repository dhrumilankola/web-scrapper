import { NextResponse } from 'next/server';
import { scrapeWebsite } from '@/lib/scraper';
import { detectAuthentication } from '@/lib/detector';
import { logger } from '@/lib/logger';
import { browserPool } from '@/lib/browser-pool';

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
       * Return successful detection result
       */
      const res = NextResponse.json({
        ...detectionResult,
        pageTitle: scrapeResult.title,
        screenshot: scrapeResult.screenshot,
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
 * Health check endpoint
 */
export async function GET() {
  const res = NextResponse.json({
    status: 'ok',
    service: 'auth-component-detector',
    version: '2.0.0',
  });
  Object.entries(corsHeaders).forEach(([k, v]) => res.headers.set(k, v));
  return res;
}