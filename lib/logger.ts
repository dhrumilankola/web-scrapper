/**
 * Structured Logging Service
 */

export class Logger {
  private colors = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    dim: '\x1b[2m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
    white: '\x1b[37m',
  };

  /**
   * Generate unique request ID for tracking
   * Format: REQ-{8 random hex chars}
   */
  generateRequestId(): string {
    return `REQ-${Math.random().toString(16).slice(2, 10)}`;
  }

  /**
   * Get current timestamp in readable format
   */
  private getTimestamp(): string {
    const now = new Date();
    return now.toISOString().replace('T', ' ').slice(0, 19);
  }

  /**
   * Calculate duration from start time
   */
  private getDuration(startTime?: number): string {
    if (!startTime) return '';
    const duration = Date.now() - startTime;
    return `${duration}ms`;
  }

  /**
   * Format log message with timestamp, request ID, and step
   */
  private formatMessage(
    requestId: string,
    step: string,
    level: 'INFO' | 'WARN' | 'ERROR' | 'SUCCESS'
  ): string {
    const timestamp = this.getTimestamp();
    const color =
      level === 'ERROR'
        ? this.colors.red
        : level === 'WARN'
          ? this.colors.yellow
          : level === 'SUCCESS'
            ? this.colors.green
            : this.colors.cyan;

    return `${this.colors.dim}[${timestamp}]${this.colors.reset} ${color}[${requestId}]${this.colors.reset} ${this.colors.bright}${step}${this.colors.reset}`;
  }

  /**
   * Log info message with optional data and duration
   * 
   * @param requestId - Unique request identifier
   * @param step - Step name (e.g., 'SCRAPE_START', 'AI_DETECTION')
   * @param data - Additional context data
   * @param startTime - Start timestamp for duration calculation
   */
  info(requestId: string, step: string, data?: Record<string, unknown>, startTime?: number): void {
    const message = this.formatMessage(requestId, step, 'INFO');
    console.log(message);

    if (data) {
      Object.entries(data).forEach(([key, value]) => {
        const formattedValue = this.formatValue(value);
        console.log(`  ${this.colors.dim}${key}:${this.colors.reset} ${formattedValue}`);
      });
    }

    if (startTime) {
      const duration = this.getDuration(startTime);
      console.log(`  ${this.colors.dim}duration:${this.colors.reset} ${this.colors.green}${duration}${this.colors.reset}`);
    }
  }

  /**
   * Log success message
   */
  success(
    requestId: string,
    step: string,
    data?: Record<string, unknown>,
    startTime?: number
  ): void {
    const message = this.formatMessage(requestId, step, 'SUCCESS');
    console.log(message);

    if (data) {
      Object.entries(data).forEach(([key, value]) => {
        const formattedValue = this.formatValue(value);
        console.log(`  ${this.colors.dim}${key}:${this.colors.reset} ${formattedValue}`);
      });
    }

    if (startTime) {
      const duration = this.getDuration(startTime);
      console.log(`  ${this.colors.dim}duration:${this.colors.reset} ${this.colors.green}${duration}${this.colors.reset}`);
    }
  }

  /**
   * Log warning message
   */
  warn(requestId: string, step: string, message: string, data?: Record<string, unknown>): void {
    const formattedMessage = this.formatMessage(requestId, step, 'WARN');
    console.warn(formattedMessage);
    console.warn(`  ${this.colors.yellow}${message}${this.colors.reset}`);

    if (data) {
      Object.entries(data).forEach(([key, value]) => {
        const formattedValue = this.formatValue(value);
        console.warn(`  ${this.colors.dim}${key}:${this.colors.reset} ${formattedValue}`);
      });
    }
  }

  /**
   * Log error with stack trace and context
   * 
   * @param requestId - Unique request identifier
   * @param step - Step where error occurred
   * @param error - Error object or message
   * @param context - Additional context data
   */
  error(
    requestId: string,
    step: string,
    error: Error | string,
    context?: Record<string, unknown>
  ): void {
    const message = this.formatMessage(requestId, step, 'ERROR');
    console.error(message);

    const errorMessage = error instanceof Error ? error.message : error;
    console.error(`  ${this.colors.red}${errorMessage}${this.colors.reset}`);

    if (error instanceof Error && error.stack) {
      const stackLines = error.stack.split('\n').slice(1, 4);
      stackLines.forEach((line) => {
        console.error(`  ${this.colors.dim}${line.trim()}${this.colors.reset}`);
      });
    }

    if (context) {
      console.error(`  ${this.colors.dim}Context:${this.colors.reset}`);
      Object.entries(context).forEach(([key, value]) => {
        const formattedValue = this.formatValue(value);
        console.error(`    ${this.colors.dim}${key}:${this.colors.reset} ${formattedValue}`);
      });
    }
  }

  /**
   * Log performance metrics for a complete request
   * 
   * @param requestId - Unique request identifier
   * @param metrics - Performance metrics object
   */
  performance(requestId: string, metrics: PerformanceMetrics): void {
    const message = this.formatMessage(requestId, 'PERFORMANCE_METRICS', 'INFO');
    console.log(message);

    console.log(`  ${this.colors.dim}Total Duration:${this.colors.reset} ${this.colors.green}${metrics.totalDuration}ms${this.colors.reset}`);
    console.log(`  ${this.colors.dim}Scrape Duration:${this.colors.reset} ${metrics.scrapeDuration}ms`);
    console.log(`  ${this.colors.dim}Detection Duration:${this.colors.reset} ${metrics.detectionDuration}ms`);
    console.log(`  ${this.colors.dim}HTML Size:${this.colors.reset} ${this.formatBytes(metrics.htmlSize)}`);
    
    if (metrics.screenshotSize) {
      console.log(`  ${this.colors.dim}Screenshot Size:${this.colors.reset} ${this.formatBytes(metrics.screenshotSize)}`);
    }

    console.log(`  ${this.colors.dim}Detection Method:${this.colors.reset} ${metrics.detectionMethod}`);
    console.log(`  ${this.colors.dim}Auth Found:${this.colors.reset} ${metrics.authFound ? this.colors.green + 'Yes' : this.colors.red + 'No'}${this.colors.reset}`);
    
    if (metrics.componentsCount) {
      console.log(`  ${this.colors.dim}Components Found:${this.colors.reset} ${metrics.componentsCount}`);
    }
  }

  /**
   * Format value for display
   */
  private formatValue(value: unknown): string {
    if (typeof value === 'string') {
      return value.length > 100 ? `${value.slice(0, 100)}...` : value;
    }
    if (typeof value === 'number') {
      return value.toString();
    }
    if (typeof value === 'boolean') {
      return value ? this.colors.green + 'true' + this.colors.reset : this.colors.red + 'false' + this.colors.reset;
    }
    if (Array.isArray(value)) {
      return `[${value.join(', ')}]`;
    }
    if (typeof value === 'object' && value !== null) {
      return JSON.stringify(value, null, 2);
    }
    return String(value);
  }

  /**
   * Format bytes to human-readable string
   */
  private formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  }
}

/**
 * Performance metrics interface
 */
export interface PerformanceMetrics {
  totalDuration: number;
  scrapeDuration: number;
  detectionDuration: number;
  htmlSize: number;
  screenshotSize?: number;
  detectionMethod: 'ai' | 'pattern' | 'hybrid' | 'none';
  authFound: boolean;
  componentsCount?: number;
}

/**
 * Export singleton instance
 */
export const logger = new Logger();

