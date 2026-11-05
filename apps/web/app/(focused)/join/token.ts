/** For this tab only, and only until it's used. Sign-in leaves this page, and the token never goes in a URL it would send. */
const STORAGE_KEY = "podster-org-invitation";
const MAX_TOKEN = 200;

export const signInHref = "/sign-in?next=%2Fjoin";

const read = () => {
  try {
    return sessionStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
};

const write = (token: string) => {
  try {
    sessionStorage.setItem(STORAGE_KEY, token);
    return true;
  } catch {
    return false;
  }
};

export function forgetToken() {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing was kept, then.
  }
}

/**
 * The token from the link, or from before sign-in. It moves out of the address bar so it isn't left in history or copied
 * along with the URL, unless this browser can't keep it, when the address is all there is.
 */
export function takeToken(): { token: string | null; kept: boolean } {
  const fragment = window.location.hash.slice(1);
  if (fragment && fragment.length <= MAX_TOKEN) {
    const kept = write(fragment);
    if (kept) window.history.replaceState(null, "", window.location.pathname);
    return { token: fragment, kept };
  }
  return { token: read(), kept: true };
}
