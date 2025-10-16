import { Page } from 'playwright';
import { logger } from './logger';

export async function extractShadowDOMContent(
  page: Page,
  requestId: string
): Promise<string> {
  logger.info(requestId, 'SHADOW_DOM_EXTRACTION_START', {
    message: 'Extracting content from shadow DOM elements',
  });

  const shadowHTML = await page.evaluate(() => {
    let shadowContent = '';
    const allElements = document.querySelectorAll('*');

    allElements.forEach((element) => {
      if (element.shadowRoot) {
        shadowContent += element.shadowRoot.innerHTML + '\n';
      }
    });

    return shadowContent;
  });

  if (shadowHTML.length > 0) {
    logger.success(requestId, 'SHADOW_DOM_EXTRACTION_SUCCESS', {
      size: `${Math.round(shadowHTML.length / 1024)}KB`,
      message: 'Shadow DOM content extracted',
    });
  } else {
    logger.info(requestId, 'SHADOW_DOM_EXTRACTION_EMPTY', {
      message: 'No shadow DOM elements found',
    });
  }

  return shadowHTML;
}

export async function triggerAuthModals(
  page: Page,
  requestId: string
): Promise<boolean> {
  logger.info(requestId, 'AUTH_MODAL_TRIGGER_START', {
    message: 'Attempting to reveal hidden auth modals',
  });

  // Prioritized list: most common patterns first for faster detection
  const authTriggers = [
    { type: 'text', selector: 'button:has-text("Sign in")', name: 'Sign in button' },
    { type: 'text', selector: 'button:has-text("Log in")', name: 'Log in button' },
    { type: 'text', selector: 'button:has-text("Login")', name: 'Login button' },
    { type: 'text', selector: 'a:has-text("Sign in")', name: 'Sign in link' },
    { type: 'text', selector: 'a:has-text("Log in")', name: 'Log in link' },
    { type: 'text', selector: 'a:has-text("Login")', name: 'Login link' },
    { type: 'attr', selector: '[data-testid*="login"]', name: 'Login testid' },
    { type: 'attr', selector: '[data-testid*="signin"]', name: 'Signin testid' },
    { type: 'attr', selector: '[aria-label*="login" i]', name: 'Login aria-label' },
    { type: 'attr', selector: '[aria-label*="sign in" i]', name: 'Sign in aria-label' },
    { type: 'class', selector: '.login-button', name: 'Login class' },
    { type: 'class', selector: '.signin-button', name: 'Signin class' },
    { type: 'class', selector: '.auth-button', name: 'Auth class' },
    { type: 'class', selector: '.sign-in-btn', name: 'Sign in btn class' },
  ];

  const startTime = Date.now();
  const maxAttemptTime = 5000; // Cap total time spent on modal triggering

  for (const trigger of authTriggers) {
    // Early exit if we've spent too long
    if (Date.now() - startTime > maxAttemptTime) {
      logger.info(requestId, 'AUTH_MODAL_TRIGGER_TIMEOUT', {
        message: 'Max attempt time reached, continuing without modal',
        timeSpent: `${Date.now() - startTime}ms`,
      });
      break;
    }

    try {
      const element = await page.$(trigger.selector);
      if (element) {
        logger.info(requestId, 'AUTH_TRIGGER_FOUND', {
          selector: trigger.selector,
          name: trigger.name,
          action: 'clicking to reveal modal',
        });

        await element.click({ timeout: 1000 });
        
        // Reduced wait time with early modal detection
        await page.waitForTimeout(300);

        const modalVisible = await page.evaluate(() => {
          const modals = document.querySelectorAll(
            '[role="dialog"], [role="alertdialog"], .modal, [class*="modal" i], [class*="dialog" i], [aria-modal="true"]'
          );
          return modals.length > 0 && Array.from(modals).some((modal: Element) => {
            const htmlModal = modal as HTMLElement;
            return htmlModal.offsetParent !== null;
          });
        });

        if (modalVisible) {
          logger.success(requestId, 'AUTH_MODAL_REVEALED', {
            trigger: trigger.name,
            selector: trigger.selector,
            totalTime: `${Date.now() - startTime}ms`,
          });
          return true;
        }
      }
    } catch (_err) {
      continue;
    }
  }

  logger.info(requestId, 'AUTH_MODAL_TRIGGER_COMPLETE', {
    modalRevealed: false,
    message: 'No auth modals found or triggered',
    totalTime: `${Date.now() - startTime}ms`,
  });

  return false;
}

export interface A11yNode {
  name?: string;
  role?: string;
  value?: string;
  children?: A11yNode[];
}

export async function getAccessibilityAuthSignals(
  page: Page,
  requestId: string
): Promise<{ hasAuth: boolean; signals: string[] }> {
  logger.info(requestId, 'A11Y_AUTH_CHECK_START', {
    message: 'Checking accessibility tree for auth signals',
  });

  try {
    const snapshot = (await page.accessibility.snapshot()) as A11yNode | null;
    const signals: string[] = [];

    function traverse(node: A11yNode | null | undefined) {
      if (!node) return;

      const name = node.name?.toLowerCase() || '';
      const role = node.role?.toLowerCase() || '';
      const value = node.value?.toLowerCase() || '';

      const authKeywords = [
        'login',
        'signin',
        'sign in',
        'log in',
        'password',
        'email',
        'username',
        'register',
        'signup',
        'sign up',
      ];

      const hasAuthKeyword = authKeywords.some((keyword) =>
        name.includes(keyword) || value.includes(keyword)
      );

      if (hasAuthKeyword && (role === 'textbox' || role === 'button' || role === 'link')) {
        signals.push(`${role}: ${name || value}`);
      }

      if (node.children) {
        node.children.forEach(traverse);
      }
    }

    traverse(snapshot);

    const hasAuth = signals.length > 0;

    if (hasAuth) {
      logger.success(requestId, 'A11Y_AUTH_SIGNALS_FOUND', {
        count: signals.length,
        signals: signals.slice(0, 5),
      });
    } else {
      logger.info(requestId, 'A11Y_AUTH_SIGNALS_NONE', {
        message: 'No auth signals in accessibility tree',
      });
    }

    return { hasAuth, signals };
  } catch (_err) {
    logger.warn(requestId, 'A11Y_AUTH_CHECK_FAILED', 'Failed to check accessibility tree', {
      error: _err instanceof Error ? _err.message : String(_err),
    });
    return { hasAuth: false, signals: [] };
  }
}

export async function waitForModernWebApp(
  page: Page,
  requestId: string
): Promise<void> {
  logger.info(requestId, 'MODERN_WEB_WAIT_START', {
    message: 'Waiting for modern web app to fully load',
  });

  let achievedNetworkIdle = false;
  try {
    await page.waitForLoadState('networkidle', { timeout: 10000 });
    achievedNetworkIdle = true;
    logger.success(requestId, 'MODERN_WEB_WAIT_NETWORK_IDLE', {
      message: 'Network idle achieved',
    });
  } catch (_err) {
    logger.warn(requestId, 'MODERN_WEB_WAIT_TIMEOUT', 'Network idle timeout, continuing', {
      message: 'Site may still be loading resources',
    });
  }

  // Adaptive wait: shorter if network already idle, longer if timed out
  const additionalWait = achievedNetworkIdle ? 500 : 1500;
  await page.waitForTimeout(additionalWait);

  logger.success(requestId, 'MODERN_WEB_WAIT_COMPLETE', {
    message: 'Modern web app load wait complete',
    additionalWait: `${additionalWait}ms`,
  });
}

