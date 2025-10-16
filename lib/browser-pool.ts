/**
 * Browser Connection Pool
 * 
 * Manages a single reusable Playwright browser instance with multiple contexts
 * to improve performance and resource efficiency.
 * 
 * Why Connection Pooling?
 * - Launching a new browser takes 2-3 seconds per request
 * - Reusing an instance reduces this to ~200ms per request
 * - Saves memory by not creating multiple browser processes
 * - Provides centralized lifecycle management
 * 
 * Architecture:
 * - 1 browser instance (kept alive)
 * - New context per request (isolated)
 * - Automatic cleanup after use
 * - Health monitoring and recovery
 * 
 * Resource Usage:
 * - Browser: ~100MB RAM
 * - Context: ~10-20MB RAM per concurrent request
 * 
 * Thread Safety:
 * - Safe for concurrent requests (each gets its own context)
 * - Browser-level operations are synchronized
 */

import { chromium, Browser, BrowserContext } from 'playwright';
import { logger } from './logger';

export class BrowserPool {
  private browser: Browser | null = null;
  private isInitializing = false;
  private initPromise: Promise<Browser> | null = null;
  private lastUsed: number = Date.now();
  private readonly IDLE_TIMEOUT = 5 * 60 * 1000; 
  private idleCheckInterval: NodeJS.Timeout | null = null;

  /**
   * Get or create browser instance
   * 
   * Handles concurrent initialization requests by sharing the same promise.
   * This prevents multiple browsers from being launched simultaneously.
   */
  private async getBrowser(requestId: string): Promise<Browser> {
    /**
     * If browser exists and is connected, return it immediately
     */
    if (this.browser && this.browser.isConnected()) {
      this.lastUsed = Date.now();
      return this.browser;
    }

    /**
     * If already initializing, wait for that to complete
     * This handles race conditions when multiple requests arrive simultaneously
     */
    if (this.isInitializing && this.initPromise) {
      logger.info(requestId, 'BROWSER_POOL_WAITING', {
        message: 'Waiting for browser initialization to complete',
      });
      return this.initPromise;
    }

    /**
     * Initialize new browser
     */
    this.isInitializing = true;
    const startTime = Date.now();

    logger.info(requestId, 'BROWSER_POOL_INIT_START', {
      message: 'Launching new browser instance',
    });

    this.initPromise = chromium
      .launch({
        headless: true,
        /**
         * Browser launch arguments for stability and performance
         * - disable-dev-shm-usage: Prevents crashes in containerized environments
         * - no-sandbox: Required for some deployment environments
         * - disable-setuid-sandbox: Additional sandbox configuration
         * - disable-gpu: Not needed in headless mode
         */
        args: [
          '--disable-dev-shm-usage',
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-gpu',
        ],
      })
      .then((browser) => {
        this.browser = browser;
        this.isInitializing = false;
        this.lastUsed = Date.now();

        logger.success(requestId, 'BROWSER_POOL_INIT_SUCCESS', {
          message: 'Browser instance launched',
        }, startTime);

        /**
         * Start idle monitoring
         * Closes browser after extended period of inactivity to free resources
         */
        this.startIdleMonitoring();

        return browser;
      })
      .catch((error) => {
        this.isInitializing = false;
        this.initPromise = null;
        
        logger.error(requestId, 'BROWSER_POOL_INIT_ERROR', error, {
          message: 'Failed to launch browser',
        });

        throw error;
      });

    return this.initPromise;
  }

  /**
   * Create new browser context for isolated scraping
   * 
   * Each context is completely isolated (cookies, storage, cache)
   * This ensures requests don't interfere with each other
   * 
   * @param requestId - Request identifier for logging
   * @returns Browser context ready for use
   */
  async createContext(requestId: string): Promise<BrowserContext> {
    const browser = await this.getBrowser(requestId);
    
    logger.info(requestId, 'BROWSER_CONTEXT_CREATE', {
      message: 'Creating new browser context',
    });

    /**
     * Create context with realistic browser configuration
     * - User agent: Modern Chrome on Windows
     * - Viewport: Common desktop resolution
     * - Timezone: UTC for consistency
     */
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: {
        width: 1920,
        height: 1080,
      },
      timezoneId: 'UTC',
      /**
       * Performance optimizations
       * - Block images, fonts, and media to reduce load time
       * - Keep scripts and stylesheets (needed for auth detection)
       */
      javaScriptEnabled: true,
    });

    /**
     * Block unnecessary resources to speed up page loads
     * This can reduce load time by 50-70% while keeping auth components
     */
    await context.route('**/*', (route) => {
      const resourceType = route.request().resourceType();
      
      /**
       * Block resource types that don't affect auth detection
       * - images: Don't need logos/icons for detection
       * - fonts: Don't affect HTML structure
       * - media: Videos/audio not relevant
       */
      if (['image', 'font', 'media'].includes(resourceType)) {
        route.abort();
      } else {
        route.continue();
      }
    });

    return context;
  }

  /**
   * Close browser context and cleanup resources
   * 
   * Should be called after each scraping operation to prevent memory leaks
   * 
   * @param context - Browser context to close
   * @param requestId - Request identifier for logging
   */
  async closeContext(context: BrowserContext, requestId: string): Promise<void> {
    try {
      await context.close();
      logger.info(requestId, 'BROWSER_CONTEXT_CLOSED', {
        message: 'Browser context closed successfully',
      });
    } catch (error) {
      logger.error(requestId, 'BROWSER_CONTEXT_CLOSE_ERROR', error as Error, {
        message: 'Failed to close browser context',
      });
    }
  }

  /**
   * Start monitoring for idle timeout
   * 
   * Automatically closes browser after extended inactivity to free resources
   * Prevents indefinite resource usage when no requests are being processed
   */
  private startIdleMonitoring(): void {
    if (this.idleCheckInterval) {
      clearInterval(this.idleCheckInterval);
    }

    this.idleCheckInterval = setInterval(() => {
      const idleTime = Date.now() - this.lastUsed;
      
      if (idleTime > this.IDLE_TIMEOUT && this.browser) {
        logger.info('SYSTEM', 'BROWSER_POOL_IDLE_TIMEOUT', {
          message: 'Closing browser due to inactivity',
          idleTime: `${Math.round(idleTime / 1000)}s`,
        });
        
        this.closeBrowser('SYSTEM');
      }
    }, 60000); // Check every minute
  }

  /**
   * Gracefully close browser and cleanup
   * 
   * @param requestId - Request identifier for logging
   */
  async closeBrowser(requestId: string): Promise<void> {
    if (this.idleCheckInterval) {
      clearInterval(this.idleCheckInterval);
      this.idleCheckInterval = null;
    }

    if (this.browser) {
      try {
        await this.browser.close();
        logger.info(requestId, 'BROWSER_POOL_CLOSED', {
          message: 'Browser closed successfully',
        });
      } catch (error) {
        logger.error(requestId, 'BROWSER_POOL_CLOSE_ERROR', error as Error);
      } finally {
        this.browser = null;
      }
    }
  }

  /**
   * Check if browser is healthy and connected
   */
  isHealthy(): boolean {
    return this.browser !== null && this.browser.isConnected();
  }

  /**
   * Get browser pool status for health checks
   */
  getStatus(): {
    healthy: boolean;
    idleTime: number;
    isInitializing: boolean;
  } {
    return {
      healthy: this.isHealthy(),
      idleTime: Date.now() - this.lastUsed,
      isInitializing: this.isInitializing,
    };
  }
}

/**
 * Export singleton instance
 * 
 * Using singleton ensures only one browser pool exists across the application
 * This is critical for resource management and performance
 */
export const browserPool = new BrowserPool();

