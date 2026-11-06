export function scrollerOf(element: HTMLElement): HTMLElement | null {
  for (let parent = element.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
    if (/auto|scroll/.test(getComputedStyle(parent).overflowY)) return parent;
  }
  return null;
}

/**
 * Changes the body without moving what's being read. Measured after the change, so a browser's own scroll anchoring isn't counted
 * twice. Above the view its bottom edge stays put, and with the reader inside it the same fraction stays above the view.
 */
export function holdingPlace(article: HTMLElement, scroller: HTMLElement | null, update: () => void) {
  const viewTop = scroller ? scroller.getBoundingClientRect().top : 0;
  const before = article.getBoundingClientRect();
  update();
  if (before.height === 0 || before.top >= viewTop) return;
  const after = article.getBoundingClientRect();
  const wasAbove = before.bottom <= viewTop;
  const correction = wasAbove ? after.bottom - before.bottom : after.top - viewTop + ((viewTop - before.top) / before.height) * after.height;
  if (scroller) scroller.scrollTop += correction;
  else window.scrollBy(0, correction);
}
