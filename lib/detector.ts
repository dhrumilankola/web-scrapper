/**
 * Authentication Detection Service - AI-Powered
 * 
 * Architecture Overview:
 * ┌─────────────────────────────────────────────────────────────┐
 * │ 1. AI Detection (Primary)                                   │
 * │    - Visual + structural analysis via Gemini                │
 * │    - Dynamic Playwright selector generation                 │
 * │    - Live DOM extraction                                    │
 * └─────────────────────────────────────────────────────────────┘
 * ┌─────────────────────────────────────────────────────────────┐
 * │ 2. Pattern Detection (Fallback)                             │
 * │    - Regex-based matching                            │
 * │    - Used when AI unavailable or fails                      │
 * └─────────────────────────────────────────────────────────────┘
 * 
 * Key Features:
 * - Zero hardcoded patterns (works on ANY website)
 * - Handles React/Vue/Angular SPAs
 * - Intelligent fallback strategies
 * - Comprehensive timeout handling
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import { Page } from 'playwright';
import { logger } from './logger';
import type { AuthComponent, DetectionResult, AIDetectionResponse } from '@/lib/types/auth.types';


/*============================================================================*
 * CONFIGURATION
 *============================================================================*/

const CONFIG = {
  TIMEOUTS: {
    AI_API: 60000,
    EXTRACTION: 20000,
    SELECTOR: 5000,
    FALLBACK_OVERALL: 8000,
    FALLBACK_PER_STRATEGY: 1500,
  },
  HTML: {
    MAX_SIZE: 15000,
    MIN_SNIPPET: 20,
    MAX_SNIPPET: 1500,
  },
  AI: {
    MODEL: 'gemini-2.5-flash',
  },
} as const;

/**
 * Pre-compiled regex patterns for HTML extraction
 * Significant performance improvement over compiling on each request
 */
interface HTMLExtractionPattern {
  name: string;
  regex: RegExp;
  filter?: (match: string) => boolean;
}

const HTML_EXTRACTION_PATTERNS: HTMLExtractionPattern[] = [
  {
    name: 'password-forms',
    regex: /<form[^>]*>[\s\S]{0,2000}?<input[^>]*type=["']password["'][^>]*>[\s\S]{0,2000}?<\/form>/gi,
  },
  {
    name: 'auth-forms',
    regex: /<form[^>]*(?:login|signin|sign-in|signup|sign-up|auth|register)[^>]*>[\s\S]{0,1500}?<\/form>/gi,
  },
  {
    name: 'auth-buttons',
    regex: /<(?:button|a)[^>]*>[\s\S]{0,500}?<\/(?:button|a)>/gi,
    filter: (match: string) => /sign|login|auth|continue|google|facebook|github|twitter|apple|microsoft|linkedin|amazon|passkey|magic/i.test(match),
  },
  {
    name: 'auth-divs',
    regex: /<div[^>]*(?:class|id)=["'][^"']*(?:login|signin|sign-in|auth|authentication|oauth|social)[^"']*["'][^>]*>[\s\S]{0,1500}?<\/div>/gi,
  },
  {
    name: 'webauthn-passkey',
    regex: /<webauthn-subtle[^>]*>[\s\S]{0,800}?<\/webauthn-subtle>/gi,
  },
];


/*============================================================================*
 * TYPE DEFINITIONS
 *============================================================================*/

interface ExtractionStrategy {
  readonly selector: string;
  readonly description: string;
}

/*============================================================================*
 * MAIN DETECTION ENTRY POINT
 *============================================================================*/

/**
 * Detects authentication components on a page using AI or pattern matching
 * 
 * Flow:
 * 1. Try AI detection (if API key available)
 * 2. Fall back to pattern matching on failure
 * 3. Return structured result with extracted HTML snippets
 */
export async function detectAuthentication(
  html: string,
  url: string,
  screenshot: string | undefined,
  page: Page,
  requestId: string
): Promise<DetectionResult> {
  const startTime = Date.now();
  const apiKey = process.env['GEMINI_API_KEY'];

  logger.info(requestId, 'DETECTION_START', {
    url,
    htmlSize: `${Math.round(html.length / 1024)}KB`,
    hasApiKey: !!apiKey,
    hasScreenshot: !!screenshot,
  });

  if (apiKey) {
    try {
      const aiResult = await detectWithAI(html, url, screenshot, page, apiKey, requestId);

      logger.success(requestId, 'DETECTION_COMPLETE', {
        method: 'ai',
        found: aiResult.found,
        componentCount: aiResult.components.length,
      }, startTime);

      return aiResult;
  } catch (_err) {
    logger.error(requestId, 'DETECTION_AI_FAILED', _err as Error, {
        url,
        fallback: 'pattern-matching',
      });
    }
  }

  const patternResult = await detectWithPatterns(html, url, page, requestId);

  logger.success(requestId, 'DETECTION_COMPLETE', {
    method: 'pattern',
    found: patternResult.found,
    componentCount: patternResult.components.length,
  }, startTime);

  return patternResult;
}


/*============================================================================*
 * AI-POWERED DETECTION
 *============================================================================*/

/**
 * Primary detection method using Gemini AI with visual understanding
 * 
 * Process:
 * 1. Extract relevant HTML sections
 * 2. Build comprehensive prompt with guidelines
 * 3. Call Gemini API with timeout protection
 * 4. Parse AI response and extract selectors
 * 5. Use Playwright to extract actual HTML from live DOM
 */
async function detectWithAI(
  html: string,
  url: string,
  screenshot: string | undefined,
  page: Page,
  apiKey: string,
  requestId: string
): Promise<DetectionResult> {
  const startTime = Date.now();

  logger.info(requestId, 'AI_DETECTION_START', {
    model: CONFIG.AI.MODEL,
    hasScreenshot: !!screenshot,
    timeout: `${CONFIG.TIMEOUTS.AI_API}ms`,
  });

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: CONFIG.AI.MODEL });

  const relevantHTML = extractRelevantHTML(html, requestId);
  const prompt = buildAIPrompt(url, relevantHTML, !!screenshot);

  const contentParts = buildContentParts(screenshot, prompt);

  logger.info(requestId, 'AI_API_CALL_START', {
    promptLength: prompt.length,
    htmlLength: relevantHTML.length,
    hasScreenshot: !!screenshot,
  });

  const responseText = await executeWithTimeout(
    model.generateContent(contentParts),
    CONFIG.TIMEOUTS.AI_API,
    'AI API timeout'
  ).then((result) => result.response.text());

  logger.success(requestId, 'AI_API_CALL_SUCCESS', {
    responseLength: responseText.length,
  }, startTime);

  const aiResult = parseAIResponse(responseText, requestId);

  if (aiResult.components.length > 0) {
    logger.info(requestId, 'AI_COMPONENTS_FOUND', {
      count: aiResult.components.length,
      types: aiResult.components.map((c) => c.type).join(', '),
    });
  }

  logger.info(requestId, 'EXTRACTION_START', {
    componentCount: aiResult.components.length,
    timeout: `${CONFIG.TIMEOUTS.EXTRACTION}ms`,
  });

  const componentsWithSnippets = await extractSnippetsWithTimeout(
    aiResult.components,
    page,
    requestId
  );

  logger.success(requestId, 'AI_DETECTION_SUCCESS', {
    found: aiResult.found,
    componentCount: componentsWithSnippets.length,
  }, startTime);

  return {
    success: true,
    url,
    found: aiResult.found,
    components: componentsWithSnippets,
    detectionMethod: 'ai' as const,
  };
}


/*============================================================================*
 * AI HELPER FUNCTIONS
 *============================================================================*/

/**
 * Constructs content parts for Gemini API request
 * Handles optional screenshot inclusion
 */
type ContentPart = { text: string } | { inlineData: { mimeType: string; data: string } };

function buildContentParts(screenshot: string | undefined, prompt: string): ContentPart[] {
  const contentParts: ContentPart[] = [];

  if (screenshot) {
    const base64Data = screenshot.replace(/^data:image\/\w+;base64,/, '');
    contentParts.push({
      inlineData: {
        mimeType: 'image/jpeg',
        data: base64Data,
      },
    });
  }

  contentParts.push({ text: prompt });

  return contentParts;
}

/**
 * Builds comprehensive AI prompt with detection guidelines and examples
 */
function buildAIPrompt(url: string, html: string, hasScreenshot: boolean): string {
  return `You are an expert at detecting authentication components on websites by analyzing both visual layout and HTML structure.

URL: ${url}

TASK: Analyze this page and identify ALL authentication methods present. For each component found, provide a Playwright selector to extract the exact HTML.

AUTHENTICATION TYPES TO DETECT:

1. **traditional** - Login forms with username/email + password fields
   - Look for: <form> with password input, email/username input
   - Example: Traditional email + password login

2. **oauth** - Social login buttons (OAuth/SSO providers)
   - Look for: Buttons/links for Google, Facebook, GitHub, Twitter, Microsoft, Apple, LinkedIn, Amazon, etc.
   - IMPORTANT: List ALL providers you see (scan the entire page carefully)
   - CRITICAL: OAuth is for EXTERNAL provider authentication (e.g., "Sign in with Google")
   - Example: "Continue with Google", "Sign in with GitHub", "Login with Facebook"
   
   **EXTRACTION STRATEGY FOR OAUTH (CRITICAL):**
   - If you see MULTIPLE providers (e.g., Google and Apple):
     * First try: Parent container selector that includes ALL buttons
     * Example: "div.social-login-buttons" or "div:has(button:has-text('Google'))"
   - If parent container unclear:
     * Provide selector for the FIRST provider only
     * Fallback will find others
     * Example: Just "button:has-text('Sign in with Apple')" (don't try to match both)
   
   **AVOID THESE MISTAKES:**
   - ❌ BAD: "div:has(button:has-text('Google')):has(button:has-text('Apple'))"
     (Too specific - fails if one button missing or in different container)
   - ✅ GOOD: "button:has-text('Sign in with Google')" 
     (Simple, reliable)
   - ✅ GOOD: "div.auth-providers"
     (Parent container if clearly visible in HTML)

3. **passwordless** - Modern authentication without passwords
   - Methods: magic-link, otp, email-verification, passkey, webauthn, sms
   - Look for: "Send magic link", OTP inputs, "Continue with passkey", WebAuthn buttons

EXTRACTION STRATEGY:

For each component you detect, provide a PLAYWRIGHT SELECTOR that can extract the HTML element(s).

**Playwright Selector Guidelines:**
- Use text content when possible: \`button:has-text("Continue with Google")\`
- For containers with multiple items: \`div:has(button:has-text("Continue with Google"))\`
- For forms: \`form:has(input[type="password"])\`
- Use attributes: \`[data-provider="google"]\` or \`[aria-label*="login"]\`
- Be specific but flexible: Prefer text over classes (classes may change)

**Important Rules:**
1. Scan the ENTIRE page - don't stop at first match
2. For OAuth: If you see multiple providers (Google, Apple, GitHub), list them ALL
3. For OAuth with multiple providers: Provide ONE selector that captures the CONTAINER with all buttons
4. If unsure about exact selector, provide your best guess - fallback will handle it

REQUIRED JSON OUTPUT FORMAT:

{
  "found": true,
  "components": [
    {
      "type": "traditional",
      "details": {
        "fields": ["email", "password"],
        "playwrightSelector": "form:has(input[type='password'])",
        "extractionNote": "Main login form with email and password"
      }
    },
    {
      "type": "oauth",
      "details": {
        "providers": ["google", "apple", "github"],
        "playwrightSelector": "div.auth-providers",
        "extractionNote": "Container with all OAuth buttons"
      }
    },
    {
      "type": "passwordless",
      "details": {
        "method": "passkey",
        "playwrightSelector": "button:has-text('Continue with passkey')",
        "extractionNote": "WebAuthn passkey button"
      }
    }
  ]
}

If NO authentication found, return:
{
  "found": false,
  "components": []
}

${hasScreenshot ? '\nVISUAL CONTEXT: I have provided a screenshot of the page. Use this to understand the layout and visually identify auth components that may not be obvious from HTML alone.\n' : ''}

HTML TO ANALYZE:
${html}

Return ONLY valid JSON with Playwright selectors:`;
}

/**
 * Extracts relevant HTML sections for AI analysis
 * Reduces token usage while maintaining detection accuracy
 * 
 * Priority order:
 * 1. Password forms (highest priority)
 * 2. Auth-related forms
 * 3. Auth buttons/links
 * 4. Auth container divs
 * 5. WebAuthn/Passkey elements
 */
function extractRelevantHTML(html: string, requestId: string): string {
  logger.info(requestId, 'HTML_EXTRACTION_START', {
    originalSize: `${Math.round(html.length / 1024)}KB`,
  });

  const extractedSections: string[] = [];

  // Use pre-compiled patterns for better performance
  for (const pattern of HTML_EXTRACTION_PATTERNS) {
    // Reset regex lastIndex for reuse (important for global regex)
    pattern.regex.lastIndex = 0;
    
    const matches = html.match(pattern.regex);
    if (matches) {
      const filtered = pattern.filter ? matches.filter(pattern.filter) : matches;
      extractedSections.push(...filtered);
      logger.info(requestId, 'HTML_EXTRACTION_FOUND', {
        pattern: pattern.name,
        count: filtered.length,
      });
    }
  }

  let relevantHTML = Array.from(new Set(extractedSections)).join('\n\n');

  if (relevantHTML.length < CONFIG.HTML.MIN_SNIPPET) {
    logger.warn(requestId, 'HTML_EXTRACTION_MINIMAL', 'Using body fallback');
    const bodyMatch = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
    relevantHTML = bodyMatch?.[1]?.slice(0, CONFIG.HTML.MAX_SIZE) || html.slice(0, CONFIG.HTML.MAX_SIZE);
  } else {
    relevantHTML = relevantHTML.slice(0, CONFIG.HTML.MAX_SIZE);
    logger.success(requestId, 'HTML_EXTRACTION_SUCCESS', {
      extractedSize: `${Math.round(relevantHTML.length / 1024)}KB`,
      sectionsFound: extractedSections.length,
      compressionRatio: `${Math.round((relevantHTML.length / html.length) * 100)}%`,
    });
  }

  return relevantHTML;
}

/**
 * Parses and validates AI JSON response
 * Handles common JSON formatting issues
 */
function parseAIResponse(responseText: string, requestId: string): AIDetectionResponse {
  logger.info(requestId, 'AI_RESPONSE_PARSE_START', {
    responseLength: responseText.length,
  });

  const jsonMatch = responseText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('No JSON found in AI response');
  }

  const cleanedJSON = jsonMatch[0]
    .replace(/,(\s*[}\]])/g, '$1')
    .replace(/\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');

  try {
    const parsed = JSON.parse(cleanedJSON);

    logger.success(requestId, 'AI_RESPONSE_PARSE_SUCCESS', {
      componentsFound: parsed.components?.length || 0,
    });

    return {
      found: parsed.found || false,
      components: Array.isArray(parsed.components) ? parsed.components : [],
    };
  } catch (_err) {
    logger.error(requestId, 'AI_RESPONSE_PARSE_ERROR', _err as Error, {
      responsePreview: responseText.slice(0, 200),
    });
    throw new Error('Failed to parse AI response');
  }
}


/*============================================================================*
 * PLAYWRIGHT EXTRACTION
 *============================================================================*/

/**
 * Extracts HTML snippets using AI-generated Playwright selectors
 * Core innovation: AI generates strategy, Playwright executes on live DOM
 */
async function extractSnippetsWithTimeout(
  components: AuthComponent[],
  page: Page,
  requestId: string
): Promise<AuthComponent[]> {
  logger.info(requestId, 'PLAYWRIGHT_EXTRACTION_START', {
    componentCount: components.length,
  });

  const extractionPromise = Promise.all(
    components.map((component) => extractComponentSnippet(component, page, requestId))
  );

  const timeoutPromise = new Promise<AuthComponent[]>((resolve) => {
    setTimeout(() => {
      logger.warn(requestId, 'EXTRACTION_TIMEOUT', 'Returning partial results');
      resolve(
        components.map((c) => ({
          ...c,
          snippet: `<!-- ${c.type} detected but extraction timed out -->`,
        }))
      );
    }, CONFIG.TIMEOUTS.EXTRACTION);
  });

  const componentsWithSnippets = await Promise.race([extractionPromise, timeoutPromise]);

  logger.success(requestId, 'PLAYWRIGHT_EXTRACTION_COMPLETE', {
    componentCount: componentsWithSnippets.length,
    successCount: componentsWithSnippets.filter(
      (c) => c.snippet && !c.snippet.includes('extraction failed')
    ).length,
  });

  return componentsWithSnippets;
}

/**
 * Extracts snippet for a single component with fallback handling
 */
async function extractComponentSnippet(
  component: AuthComponent,
  page: Page,
  requestId: string
): Promise<AuthComponent> {
  const selector = component.details.playwrightSelector;

  if (!selector) {
    logger.warn(requestId, 'PLAYWRIGHT_EXTRACTION_NO_SELECTOR', 'Component missing selector', {
      type: component.type,
    });
    return {
      ...component,
      snippet: `<!-- ${component.type} auth detected but no selector provided -->`,
    };
  }

  try {
    logger.info(requestId, 'PLAYWRIGHT_EXTRACTION_ATTEMPT', {
      type: component.type,
      selector,
    });

    const snippet = await extractWithSelector(page, selector, requestId);

    if (snippet) {
      logger.success(requestId, 'PLAYWRIGHT_EXTRACTION_SUCCESS', {
        type: component.type,
        selector,
        snippetLength: snippet.length,
      });

      return {
        ...component,
        snippet: truncateSnippet(snippet),
      };
    }

    logger.warn(requestId, 'PLAYWRIGHT_EXTRACTION_SELECTOR_FAILED', 'Trying fallback', {
      type: component.type,
    });

    const fallbackSnippet = await intelligentFallbackExtraction(page, component, requestId);

    return {
      ...component,
      snippet: fallbackSnippet,
    };
  } catch (_err) {
    logger.error(requestId, 'PLAYWRIGHT_EXTRACTION_ERROR', _err as Error, {
      type: component.type,
      selector,
    });

    return {
      ...component,
      snippet: `<!-- ${component.type} auth detected (extraction failed) -->`,
    };
  }
}

/**
 * Extracts HTML using Playwright selector with timeout protection
 */
async function extractWithSelector(
  page: Page,
  selector: string,
  requestId: string
): Promise<string | null> {
  try {
    const element = page.locator(selector).first();

    await element
      .waitFor({
        state: 'attached',
        timeout: CONFIG.TIMEOUTS.SELECTOR,
      })
      .catch(() => {
        /* Element doesn't exist */
      });

    const count = await element.count();
    if (count === 0) {
      return null;
    }

    return await element.evaluate((el) => el.outerHTML);
  } catch (_err) {
    logger.warn(requestId, 'EXTRACTION_TIMEOUT', 'Element extraction timeout', {
      selector,
    });
    return null;
  }
}


/*============================================================================*
 * INTELLIGENT FALLBACK EXTRACTION
 *============================================================================*/

/**
 * Routes to type-specific fallback extraction when AI selector fails
 */
async function intelligentFallbackExtraction(
  page: Page,
  component: AuthComponent,
  requestId: string
): Promise<string> {
  logger.info(requestId, 'FALLBACK_EXTRACTION_START', {
    type: component.type,
  });

  const fallbackHandlers: Record<string, () => Promise<string>> = {
    oauth: () => extractOAuthFallback(page, component, requestId),
    traditional: () => extractTraditionalFallback(page, requestId),
    passwordless: () => extractPasswordlessFallback(page, component, requestId),
  };

  const handler = fallbackHandlers[component.type];
  if (handler) {
    return await handler();
  }

  return `<!-- ${component.type} auth detected (fallback failed) -->`;
}

/**
 * OAuth fallback with aggressive timeout control
 * Attempts multiple strategies per provider with time constraints
 */
async function extractOAuthFallback(
  page: Page,
  component: AuthComponent,
  requestId: string
): Promise<string> {
  const providers = component.details.providers || [];
  const startTime = Date.now();

  logger.info(requestId, 'FALLBACK_EXTRACTION_AGGRESSIVE', {
    providers: providers.join(', '),
    maxTime: `${CONFIG.TIMEOUTS.FALLBACK_OVERALL}ms`,
  });

  for (const provider of providers) {
    if (Date.now() - startTime > CONFIG.TIMEOUTS.FALLBACK_OVERALL) {
      logger.warn(requestId, 'FALLBACK_TIMEOUT_OVERALL', 'Overall timeout reached', {
        timeElapsed: `${Date.now() - startTime}ms`,
        providersChecked: providers.indexOf(provider),
      });
      break;
    }

    const strategies = buildOAuthStrategies(provider);

    for (const strategy of strategies) {
      if (Date.now() - startTime > CONFIG.TIMEOUTS.FALLBACK_OVERALL) {
        break;
      }

      const snippet = await attemptStrategyWithTimeout(
        page,
        strategy,
        requestId,
        CONFIG.TIMEOUTS.FALLBACK_PER_STRATEGY
      );

      if (snippet) {
        logger.success(requestId, 'FALLBACK_EXTRACTION_SUCCESS', {
          type: 'oauth',
          provider,
          strategy: strategy.selector,
          totalTime: `${Date.now() - startTime}ms`,
        });
        return snippet;
      }
    }
  }

  logger.warn(requestId, 'FALLBACK_EXTRACTION_FAILED', 'Could not extract OAuth within timeout', {
    timeElapsed: `${Date.now() - startTime}ms`,
    providersAttempted: providers.join(', '),
  });

  return `<!-- OAuth detected: ${providers.join(', ')} (extraction timed out after ${Date.now() - startTime}ms) -->`;
}

/**
 * Traditional auth fallback extraction
 */
async function extractTraditionalFallback(page: Page, requestId: string): Promise<string> {
  const strategies: ExtractionStrategy[] = [
    { selector: 'form:has(input[type="password"])', description: 'Password form' },
    { selector: 'form[action*="login"]', description: 'Login action form' },
    { selector: 'form[action*="signin"]', description: 'Signin action form' },
    { selector: 'form[action*="auth"]', description: 'Auth action form' },
  ];

  const snippet = await tryStrategiesSequentially(page, strategies, requestId);
  return snippet || '<!-- Traditional login detected (could not extract HTML) -->';
}

/**
 * Passwordless auth fallback extraction
 */
async function extractPasswordlessFallback(
  page: Page,
  component: AuthComponent,
  requestId: string
): Promise<string> {
  const method = component.details.method || '';

  const strategies: ExtractionStrategy[] = [
    { selector: `button:has-text("${method}")`, description: `Method-specific: ${method}` },
    { selector: 'button:has-text("passkey")', description: 'Passkey button' },
    { selector: 'button:has-text("magic link")', description: 'Magic link button' },
    { selector: 'input[inputmode="numeric"]', description: 'Numeric OTP input' },
    { selector: 'webauthn-subtle', description: 'WebAuthn element' },
  ];

  const snippet = await tryStrategiesSequentially(page, strategies, requestId);
  return snippet || `<!-- Passwordless (${method}) detected (could not extract HTML) -->`;
}


/*============================================================================*
 * EXTRACTION UTILITIES
 *============================================================================*/

/**
 * Builds OAuth extraction strategies for a given provider
 */
function buildOAuthStrategies(provider: string): ExtractionStrategy[] {
  return [
    {
      selector: `button:has-text("${provider}")`,
      description: `Direct text match: ${provider}`,
    },
    {
      selector: `button:has-text("Sign in with ${provider}")`,
      description: `Sign in pattern: ${provider}`,
    },
    {
      selector: `[data-provider="${provider.toLowerCase()}"]`,
      description: `Data attribute: ${provider}`,
    },
  ];
}

/**
 * Attempts a single strategy with timeout
 */
async function attemptStrategyWithTimeout(
  page: Page,
  strategy: ExtractionStrategy,
  requestId: string,
  timeout: number
): Promise<string | null> {
  const attemptStart = Date.now();

  try {
    const snippet = await Promise.race([
      extractWithSelector(page, strategy.selector, requestId),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeout)),
    ]);

    logger.info(requestId, 'FALLBACK_ATTEMPT', {
      strategy: strategy.description,
      duration: `${Date.now() - attemptStart}ms`,
      found: !!snippet,
    });

    return snippet;
  } catch (_err) {
    return null;
  }
}

/**
 * Tries multiple strategies sequentially until one succeeds
 */
async function tryStrategiesSequentially(
  page: Page,
  strategies: ExtractionStrategy[],
  requestId: string
): Promise<string | null> {
  for (const strategy of strategies) {
    const snippet = await extractWithSelector(page, strategy.selector, requestId);
    if (snippet) {
      logger.success(requestId, 'FALLBACK_EXTRACTION_SUCCESS', {
        strategy: strategy.description,
      });
      return snippet;
    }
  }
  return null;
}


/*============================================================================*
 * PATTERN-BASED DETECTION (LEGACY)
 *============================================================================*/

/**
 * Legacy pattern-based detection (fallback only)
 * Used when: No API key OR AI detection fails
 * 
 * Simplified version focusing on most common patterns:
 * - Traditional forms with password fields
 * - OAuth buttons (text-based search)
 */
async function detectWithPatterns(
  html: string,
  url: string,
  page: Page,
  requestId: string
): Promise<DetectionResult> {
  const startTime = Date.now();

  logger.info(requestId, 'PATTERN_DETECTION_START', {
    htmlSize: `${Math.round(html.length / 1024)}KB`,
  });

  // Parallelize pattern detection for better performance
  const [traditionalComponent, oauthComponent] = await Promise.all([
    detectTraditionalPattern(page, requestId),
    detectOAuthPattern(page, requestId),
  ]);

  const components: AuthComponent[] = [];
  if (traditionalComponent) {
    components.push(traditionalComponent);
  }
  if (oauthComponent) {
    components.push(oauthComponent);
  }

  logger.success(
    requestId,
    'PATTERN_DETECTION_COMPLETE',
    {
      found: components.length > 0,
      componentCount: components.length,
    },
    startTime
  );

  return {
    success: true,
    url,
    found: components.length > 0,
    components,
    detectionMethod: 'pattern' as const,
  };
}

/**
 * Detects traditional login forms
 */
async function detectTraditionalPattern(
  page: Page,
  requestId: string
): Promise<AuthComponent | null> {
  const formSnippet = await extractWithSelector(page, 'form:has(input[type="password"])', requestId);

  if (!formSnippet) {
    return null;
  }

  const fields: string[] = [];
  if (formSnippet.includes('type="email"') || formSnippet.includes('type="text"')) {
    fields.push('email');
  }
  if (formSnippet.includes('type="password"')) {
    fields.push('password');
  }

  logger.info(requestId, 'PATTERN_FOUND', {
    type: 'traditional',
    fields: fields.join(', '),
  });

  return {
    type: 'traditional',
    snippet: truncateSnippet(formSnippet),
    details: { fields },
  };
}

/**
 * Detects OAuth providers (parallelized for performance)
 */
async function detectOAuthPattern(page: Page, requestId: string): Promise<AuthComponent | null> {
  const oauthProviders = ['google', 'facebook', 'github', 'twitter', 'apple', 'microsoft'];
  
  // Check all providers in parallel for faster detection
  const providerResults = await Promise.all(
    oauthProviders.map(async (provider) => ({
      provider,
      snippet: await extractWithSelector(page, `button:has-text("${provider}")`, requestId),
    }))
  );

  // Find providers that were detected
  const foundProviders: string[] = [];
  let oauthSnippet = '';

  for (const result of providerResults) {
    if (result.snippet) {
      foundProviders.push(result.provider);
      if (!oauthSnippet) {
        oauthSnippet = result.snippet;
      }
    }
  }

  if (foundProviders.length === 0) {
    return null;
  }

  logger.info(requestId, 'PATTERN_FOUND', {
    type: 'oauth',
    providers: foundProviders.join(', '),
  });

  return {
    type: 'oauth',
    snippet: oauthSnippet
      ? truncateSnippet(oauthSnippet)
      : `<!-- OAuth: ${foundProviders.join(', ')} -->`,
    details: { providers: foundProviders },
  };
}


/*============================================================================*
 * UTILITY FUNCTIONS
 *============================================================================*/

/**
 * Executes a promise with timeout
 * Generic utility for any async operation requiring timeout protection
 */
async function executeWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  errorMessage: string
): Promise<T> {
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`${errorMessage} after ${timeoutMs}ms`)), timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]);
}

/**
 * Truncates HTML snippet to max length while maintaining valid HTML structure
 * Ensures all opened tags are properly closed
 */
function truncateSnippet(snippet: string): string {
  if (snippet.length <= CONFIG.HTML.MAX_SNIPPET) {
    return snippet;
  }

  let truncated = snippet.slice(0, CONFIG.HTML.MAX_SNIPPET);

  const lastOpenTag = truncated.lastIndexOf('<');
  const lastCloseTag = truncated.lastIndexOf('>');

  if (lastOpenTag > lastCloseTag) {
    truncated = truncated.slice(0, lastOpenTag);
  }

  const openTags: string[] = [];
  const tagRegex = /<(\/?)([\w-]+)[^>]*>/g;
  let match;

  while ((match = tagRegex.exec(truncated)) !== null) {
    const isClosing = match[1] === '/';
    const tagName = match[2];

    if (tagName) {
      if (isClosing) {
        if (openTags[openTags.length - 1] === tagName) {
          openTags.pop();
        }
      } else if (!match[0].endsWith('/>')) {
        openTags.push(tagName);
      }
    }
  }

  while (openTags.length > 0) {
    const tag = openTags.pop();
    if (tag) {
      truncated += `</${tag}>`;
    }
  }

  return truncated;
}