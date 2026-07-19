(function () {
  'use strict';

  var INTERACTIVE_SELECTOR = 'button,a[href],input,select,textarea,[role="button"],[role="tab"],[role="menuitem"]';

  function hasInteractiveChild(node) {
    return !!(node && node.querySelector && node.querySelector(INTERACTIVE_SELECTOR));
  }

  function labelIconButton(button) {
    if (button.hasAttribute('aria-label') || String(button.textContent || '').trim()) return;
    var title = String(button.getAttribute('title') || '').trim();
    if (title) button.setAttribute('aria-label', title);
  }

  function makeLegacyClickTargetAccessible(node) {
    if (!node || !node.matches || !node.matches('[onclick]')) return;
    if (node.matches('button,a[href],input,select,textarea,label,summary')) return;
    if (node.matches('.dev-locked,[aria-disabled="true"]') || hasInteractiveChild(node)) return;
    if (!node.hasAttribute('role')) node.setAttribute('role', 'button');
    if (!node.hasAttribute('tabindex')) node.setAttribute('tabindex', '0');
    if (!node.hasAttribute('aria-label')) {
      var title = String(node.getAttribute('title') || '').trim();
      if (title) node.setAttribute('aria-label', title);
    }
    if (node.dataset.keyboardClickReady === '1') return;
    node.dataset.keyboardClickReady = '1';
    node.addEventListener('keydown', function (event) {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      node.click();
    });
  }

  function enhance(root) {
    if (!root || !root.querySelectorAll) return;
    if (root.matches && root.matches('button')) {
      if (!root.hasAttribute('type')) root.setAttribute('type', 'button');
      labelIconButton(root);
    }
    if (root.matches) makeLegacyClickTargetAccessible(root);
    Array.prototype.forEach.call(root.querySelectorAll('button'), function (button) {
      if (!button.hasAttribute('type')) button.setAttribute('type', 'button');
      labelIconButton(button);
    });
    Array.prototype.forEach.call(root.querySelectorAll('[onclick]'), makeLegacyClickTargetAccessible);
  }

  function installStyles() {
    if (document.getElementById('v150-accessibility-styles')) return;
    var style = document.createElement('style');
    style.id = 'v150-accessibility-styles';
    style.textContent = [
      ':where(button,a,[role="button"],[role="tab"],[role="menuitem"],input,select,textarea):focus-visible{outline:2px solid rgba(var(--fc-accent-rgb,0,245,212),.92);outline-offset:3px}',
      ':where([role="button"],[role="tab"],[role="menuitem"])[aria-disabled="true"]{cursor:not-allowed;opacity:.54}'
    ].join('');
    document.head.appendChild(style);
  }

  function init() {
    installStyles();
    var searchInput = document.getElementById('search-input');
    if (searchInput && !searchInput.hasAttribute('aria-label')) searchInput.setAttribute('aria-label', '搜索网易云音乐');
    enhance(document);
    if (!window.MutationObserver) return;
    new MutationObserver(function (records) {
      records.forEach(function (record) {
        Array.prototype.forEach.call(record.addedNodes || [], function (node) {
          if (node && node.nodeType === 1) enhance(node);
        });
      });
    }).observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
