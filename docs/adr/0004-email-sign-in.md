# ADR 0004: A sign-in link is its own way in

Status: **Proposed**, for the owner to confirm · Date: 2026-11-05

The code is built and tested locally. Nothing is deployed, and no real email has been sent.

## Context

Better Auth's magic-link plugin signs in whoever already holds an address. So a link would open a person who signed up with GitHub, without their GitHub sign-in, for anyone who controls that address now. Podster already refuses to join accounts on a matching email, because an address can move to someone else (`disableImplicitLinking`).

## Decision

**A link only signs in someone who has only ever used links.** A person with any `account` row, such as GitHub or Google, can't be reached by one.

- If they ask, they get an email with no link, saying this address signs in another way. The answer to the request is the same as for anyone, so only the mailbox learns anything.
- It's checked before sending, and again when the session is about to start, because someone can sign up with GitHub while a link is on its way. That second check is the one that holds.
- The reverse stays refused too: someone who started with a link and then tries GitHub on the same address gets the existing sign-in error, because implicit linking is off.

So one human with an address could need the sign-in they used first. Nothing joins two sign-ins, and there's no route that links them on purpose. That can come later, if it starts from a signed-in session.

## How a link works

- **Host:** both routes answer only on the application host, and 404 on the gateway's. Off until `ENABLE_EMAIL_SIGNIN`, the `EMAIL` binding, `EMAIL_FROM` and `APP_URL` are all set.
- **The link:** valid for 5 minutes and single-use, consumed atomically by Better Auth. Only a hash of the token is stored. The token isn't logged, and it isn't in any answer.
- **One click:** the link opens `/sign-in/email`, which spends nothing and has a button, because mail scanners open links and would use them up.
- **No enumeration:** after the origin, shape and per-client checks, an address known, unknown, on the test domain or at its limit gets the same answer. Sending happens after the answer, so timing doesn't tell them apart either.
- **What a caller controls:** only the address, and a path on this host to return to. The route takes no name or metadata, so a new person's name is empty and their personal organization is called "Personal".
- **Test people:** their reserved domain gets no email and no token, and the sign-up hook refuses it. This uses the test sign-up's definition of that domain, and nothing else from that path.

## Limits

Fixed in code. A counter that fails refuses, because going on would send email.

| Counted | Per minute | Per day | Past it |
| --- | --- | --- | --- |
| Address | 1 | 5 | Same answer, nothing sent |
| Client (IP, or IPv6 /64) | 5 | 30 | 429 |
| All clients | 20 | 100 | 429 |

Both routes also count under the limit of 20 a minute per client that other sign-in routes have.

## Known limits

- **Someone can use up a victim's limit,** or the daily total, and stop links going out for a while. They can't read mail or sign in, and GitHub sign-in still works.
- **A link can be opened in any browser.** That's what makes phone-to-laptop work, but someone could send you their own link and sign you in as them. The page's button makes this harder to do by accident, and doesn't stop it. Binding a link to the browser that asked would close it, and break opening it elsewhere.
- **The token is in a URL,** which is what a link is. It passes through the web Worker to the gateway, so anyone with `wrangler tail` or request logs on those Workers could see one. It also sits in Email Service's preview, if that's on. It's single-use and lasts 5 minutes.
