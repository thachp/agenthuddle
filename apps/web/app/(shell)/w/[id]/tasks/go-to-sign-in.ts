/** A full navigation, because the session is gone and nothing on this page can use it. Sign-in checks `next` itself. */
export const goToSignIn = () => window.location.assign(`/sign-in?next=${encodeURIComponent(window.location.pathname + window.location.search)}`);
