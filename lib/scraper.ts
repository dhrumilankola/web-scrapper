/**
 * Web Scraper Service - AI-Powered 
 * 
 * Architecture:
 * ┌─────────────────────────────────────────────────────────────┐
 * │ 1. Browser Context Creation                                 │
 * │    - Pooled browser management                              │
 * │    - Isolated context per request                           │
 * └─────────────────────────────────────────────────────────────┘
 * ┌─────────────────────────────────────────────────────────────┐
 * │ 2. Content Extraction                                        │
 * │    - Regular DOM + Shadow DOM                               │
 * │    - Accessibility tree analysis                            │
 * │    - Modal triggering for hidden auth                       │
 * └─────────────────────────────────────────────────────────────┘
 * ┌─────────────────────────────────────────────────────────────┐
 * │ 3. Page Lifecycle Management                                │
 * │    - Keep page alive for AI extraction                      │
 * │    - Return context for caller cleanup                      │
 * │    - Automatic cleanup on errors                            │
 * └─────────────────────────────────────────────────────────────┘
 * 
 * CRITICAL: Returns live Page and BrowserContext objects
 * Caller MUST close them after use to prevent memory leaks
 */

import { Page, BrowserContext } from 'playwright';
import { browserPool } from './browser-pool';
import { logger } from './logger';
import {
  extractShadowDOMContent,
  triggerAuthModals,
  waitForModernWebApp,
  getAccessibilityAuthSignals,
} from './modern-web-helpers';


/*============================================================================*
 * TYPE DEFINITIONS
 *============================================================================*/

export interface ScrapeResult {
  success: boolean;
  html?: string;
  title?: string;
  url: string;
  screenshot?: string;
  page?: Page;
  context?: BrowserContext;
  error?: string;
  metadata?: ScrapeMetadata;
}

interface ScrapeMetadata {
  hasShadowDOM?: boolean;
  modalTriggered?: boolean;
  hasAuthInA11y?: boolean;
  a11ySignals?: string[];
}

interface ContentExtractionResult {
  html: string;
  title: string;
  hasShadowDOM: boolean;
  hasAuthInA11y: boolean;
  a11ySignals: string[];
  modalTriggered: boolean;
}


/*============================================================================*
 * CONFIGURATION
 *============================================================================*/

const CONFIG = {
  TIMEOUTS: {
    NAVIGATION: 30000,
    TOTAL: 60000,
    SCREENSHOT: 10000,
    WAIT_AFTER_LOAD: 2000,
  },
  SCREENSHOT: {
    TYPE: 'jpeg' as const,
    QUALITY: 80,
    FULL_PAGE: false,
  },
} as const;


/*============================================================================*
 * MAIN SCRAPING FUNCTION
 *============================================================================*/

/**
 * Scrapes website and returns live page for AI extraction
 * 
 * Flow:
 * 1. Create browser context and page
 * 2. Navigate to URL with timeout protection
 * 3. Wait for modern web app hydration
 * 4. Extract content from multiple sources
 * 5. Capture screenshot (optional)
 * 6. Return live page/context for caller
 * 
 * CRITICAL: Caller must close page and context after use
 * Use: await page?.close(); await browserPool.closeContext(context, requestId);
 */
export async function scrapeWebsite(url: string, requestId: string): Promise<ScrapeResult> {
  const startTime = Date.now();
  let context: BrowserContext | undefined;
  let page: Page | undefined;

  logger.info(requestId, 'SCRAPE_START', {
    url,
    navigationTimeout: `${CONFIG.TIMEOUTS.NAVIGATION}ms`,
    totalTimeout: `${CONFIG.TIMEOUTS.TOTAL}ms`,
  });

  try {
    const result = await executeWithTimeout(
      performScrape(url, requestId, startTime),
      CONFIG.TIMEOUTS.TOTAL,
      'Scraping timeout'
    );

    context = result.context;
    page = result.page;

    return result;
  } catch (error) {
    logger.error(requestId, 'SCRAPE_FAILED', error as Error, {
      url,
      duration: `${Date.now() - startTime}ms`,
    });

    await cleanupResources(page, context, requestId);

    return {
      success: false,
      url,
      error: extractErrorMessage(error),
    };
  }
}


/*============================================================================*
 * CORE SCRAPING LOGIC
 *============================================================================*/

/**
 * Performs the actual scraping operation
 * Extracted for better error handling and testability
 */
async function performScrape(
  url: string,
  requestId: string,
  startTime: number
): Promise<ScrapeResult> {
  let context: BrowserContext | undefined;
  let page: Page | undefined;

  try {
    context = await browserPool.createContext(requestId);
    page = await context.newPage();

    await navigateToUrl(page, url, requestId);
    await waitForModernWebApp(page, requestId);

    // Parallelize content extraction and screenshot capture for better performance
    const [contentResult, screenshot] = await Promise.all([
      extractAllContent(page, requestId),
      captureScreenshot(page, requestId),
    ]);

    logScrapeSuccess(requestId, url, contentResult, screenshot, startTime);

    return buildSuccessResult(url, contentResult, screenshot, page, context);
  } catch (error) {
    logger.error(requestId, 'SCRAPE_ERROR', error as Error, {
      url,
      duration: `${Date.now() - startTime}ms`,
    });

    await cleanupResources(page, context, requestId);

    return {
      success: false,
      url,
      error: extractErrorMessage(error),
    };
  }
}


/*============================================================================*
 * NAVIGATION
 *============================================================================*/

/**
 * Navigates to URL with proper timeout and wait conditions
 */
async function navigateToUrl(page: Page, url: string, requestId: string): Promise<void> {
  logger.info(requestId, 'SCRAPE_NAVIGATE_START', {
    url,
    timeout: `${CONFIG.TIMEOUTS.NAVIGATION}ms`,
  });

  await page.goto(url, {
    waitUntil: 'domcontentloaded',
    timeout: CONFIG.TIMEOUTS.NAVIGATION,
  });

  logger.success(requestId, 'SCRAPE_NAVIGATE_SUCCESS', { url });
}


/*============================================================================*
 * CONTENT EXTRACTION
 *============================================================================*/

/**
 * Extracts content from all available sources
 * 
 * Sources:
 * 1. Regular DOM (page.content())
 * 2. Shadow DOM (custom extraction)
 * 3. Accessibility tree (auth signals)
 * 4. Auth modals (triggered dynamically)
 */
async function extractAllContent(
  page: Page,
  requestId: string
): Promise<ContentExtractionResult> {
  logger.info(requestId, 'SCRAPE_EXTRACT_CONTENT', {
    message: 'Extracting HTML from multiple sources',
  });

  // Parallelize ALL content extraction operations including modal triggering
  // Modal triggering can run alongside other operations for better performance
  const [modalTriggered, regularHTML, shadowHTML, a11yData, title] = await Promise.all([
    triggerAuthModals(page, requestId),
    page.content(),
    extractShadowDOMContent(page, requestId),
    getAccessibilityAuthSignals(page, requestId),
    page.title(),
  ]);

  const html = combineHTMLSources(regularHTML, shadowHTML);
  const hasShadowDOM = shadowHTML.length > 0;

  logger.success(requestId, 'SCRAPE_CONTENT_EXTRACTED', {
    regularHTMLSize: `${Math.round(regularHTML.length / 1024)}KB`,
    shadowHTMLSize: `${Math.round(shadowHTML.length / 1024)}KB`,
    totalHTMLSize: `${Math.round(html.length / 1024)}KB`,
    hasShadowDOM,
    hasAuthInA11y: a11yData.hasAuth,
    title: title.slice(0, 100),
    modalTriggered,
  });

  return {
    html,
    title,
    hasShadowDOM,
    hasAuthInA11y: a11yData.hasAuth,
    a11ySignals: a11yData.signals,
    modalTriggered,
  };
}

/**
 * Combines regular DOM and Shadow DOM HTML
 */
function combineHTMLSources(regularHTML: string, shadowHTML: string): string {
  if (shadowHTML.length === 0) {
    return regularHTML;
  }

  return `${regularHTML}\n\n<!-- SHADOW DOM CONTENT -->\n${shadowHTML}`;
}


/*============================================================================*
 * SCREENSHOT CAPTURE
 *============================================================================*/

/**
 * Captures page screenshot with error resilience
 * Screenshot failure is non-fatal - returns undefined on error
 */
async function captureScreenshot(page: Page, requestId: string): Promise<string | undefined> {
  try {
    logger.info(requestId, 'SCRAPE_SCREENSHOT_START', {
      format: CONFIG.SCREENSHOT.TYPE.toUpperCase(),
      quality: `${CONFIG.SCREENSHOT.QUALITY}%`,
      scope: 'viewport',
      timeout: `${CONFIG.TIMEOUTS.SCREENSHOT}ms`,
    });

    const screenshotBuffer = await page.screenshot({
      type: CONFIG.SCREENSHOT.TYPE,
      quality: CONFIG.SCREENSHOT.QUALITY,
      fullPage: CONFIG.SCREENSHOT.FULL_PAGE,
      timeout: CONFIG.TIMEOUTS.SCREENSHOT,
    });

    const screenshot = `data:image/jpeg;base64,${screenshotBuffer.toString('base64')}`;

    logger.success(requestId, 'SCRAPE_SCREENSHOT_SUCCESS', {
      size: `${Math.round(screenshotBuffer.length / 1024)}KB`,
    });

    return screenshot;
  } catch (error) {
    logger.warn(
      requestId,
      'SCRAPE_SCREENSHOT_FAILED',
      'Screenshot capture failed, continuing without it',
      {
        error: extractErrorMessage(error),
      }
    );

    return undefined;
  }
}


/*============================================================================*
 * RESULT CONSTRUCTION
 *============================================================================*/

/**
 * Builds successful scrape result object
 */
function buildSuccessResult(
  url: string,
  content: ContentExtractionResult,
  screenshot: string | undefined,
  page: Page,
  context: BrowserContext
): ScrapeResult {
  return {
    success: true,
    html: content.html,
    title: content.title,
    url,
    screenshot,
    page,
    context,
    metadata: {
      hasShadowDOM: content.hasShadowDOM,
      modalTriggered: content.modalTriggered,
      hasAuthInA11y: content.hasAuthInA11y,
      a11ySignals: content.a11ySignals,
    },
  };
}

/**
 * Logs successful scrape completion with metrics
 */
function logScrapeSuccess(
  requestId: string,
  url: string,
  content: ContentExtractionResult,
  screenshot: string | undefined,
  startTime: number
): void {
  logger.success(
    requestId,
    'SCRAPE_SUCCESS',
    {
      url,
      htmlSize: `${Math.round(content.html.length / 1024)}KB`,
      hasScreenshot: !!screenshot,
      hasShadowDOM: content.hasShadowDOM,
      modalTriggered: content.modalTriggered,
      hasAuthInA11y: content.hasAuthInA11y,
      title: content.title,
      pageKeptAlive: true,
    },
    startTime
  );
}


/*============================================================================*
 * RESOURCE MANAGEMENT
 *============================================================================*/

/**
 * Cleans up browser resources (page and context)
 * Safe to call even if resources are undefined or already closed
 */
async function cleanupResources(
  page: Page | undefined,
  context: BrowserContext | undefined,
  requestId: string
): Promise<void> {
  if (page) {
    try {
      await page.close();
    } catch (error) {
      logger.warn(requestId, 'CLEANUP_PAGE_FAILED', 'Failed to close page', {
        error: extractErrorMessage(error),
      });
    }
  }

  if (context) {
    try {
      await browserPool.closeContext(context, requestId);
    } catch (error) {
      logger.warn(requestId, 'CLEANUP_CONTEXT_FAILED', 'Failed to close context', {
        error: extractErrorMessage(error),
      });
    }
  }
}


/*============================================================================*
 * UTILITY FUNCTIONS
 *============================================================================*/

/**
 * Executes a promise with timeout protection
 * Generic utility for any async operation requiring timeout
 */
async function executeWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  errorMessage: string
): Promise<T> {
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => {
      reject(new Error(`${errorMessage} after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]);
}

/**
 * Safely extracts error message from unknown error type
 */
function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  
  if (typeof error === 'string') {
    return error;
  }
  
  return 'Unknown error';
}