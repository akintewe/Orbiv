/**
 * Orbiv Chrome Extension — Content Script
 *
 * Runs on every page. Handles:
 * - Page content extraction for "summarize this page" commands
 */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'extract-content') {
    const title = document.title || '';
    const url = window.location.href;

    // Try to find the main content area first (article body, main content, etc.)
    const contentSelectors = [
      'article',
      '[role="main"]',
      'main',
      '.mw-body-content',       // Wikipedia
      '.post-content',
      '.article-body',
      '.entry-content',
      '.content-body',
      '#mw-content-text',       // Wikipedia
      '#article-body',
      '#content',
      '.story-body',
      '.article__body',
    ];

    let contentEl = null;
    for (const sel of contentSelectors) {
      contentEl = document.querySelector(sel);
      if (contentEl && contentEl.textContent.trim().length > 200) break;
      contentEl = null;
    }

    // Fall back to body if no main content found
    const source = contentEl || document.body;
    const clone = source.cloneNode(true);

    // Remove noise elements
    const noiseSelectors = [
      'script', 'style', 'noscript', 'iframe',
      'nav', 'footer', 'header', 'aside',
      '[role="navigation"]', '[role="banner"]', '[role="complementary"]',
      '[aria-hidden="true"]',
      '.sidebar', '.nav', '.menu', '.footer', '.header', '.ad', '.ads',
      '.advertisement', '.social-share', '.comments', '.related',
      '#toc', '.toc',             // Wikipedia table of contents
      '.navbox', '.reflist',      // Wikipedia navboxes, references
      '.mw-editsection',          // Wikipedia edit links
      '.infobox',                 // Wikipedia infobox (optional, but noisy)
      '.metadata', '.catlinks',   // Wikipedia categories
    ];
    const remove = clone.querySelectorAll(noiseSelectors.join(', '));
    remove.forEach(el => el.remove());

    // Extract paragraphs for cleaner text
    const paragraphs = clone.querySelectorAll('p');
    let text = '';
    if (paragraphs.length > 3) {
      // Use paragraph text for better quality
      text = Array.from(paragraphs)
        .map(p => p.textContent.trim())
        .filter(t => t.length > 40)  // skip tiny fragments
        .join('\n\n')
        .slice(0, 8000);
    } else {
      // Fallback to full text
      text = clone.textContent
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 8000);
    }

    // Extract meta description
    const metaDesc = document.querySelector('meta[name="description"]')?.getAttribute('content') || '';

    // Extract first few headings for structure
    const headings = Array.from(clone.querySelectorAll('h1, h2, h3'))
      .slice(0, 8)
      .map(h => h.textContent.trim())
      .filter(h => h.length > 2 && h.length < 100);

    sendResponse({
      ok: true,
      title,
      url,
      description: metaDesc,
      headings,
      text,
    });
    return true;
  }
});
