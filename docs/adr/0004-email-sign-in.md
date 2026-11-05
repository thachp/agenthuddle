# ADR 0004: A sign-in link is its own way in

Status: **Proposed**, for the owner to confirm · Date: 2026-11-05

The code is built and tested locally. Nothing is deployed, and no real email has been sent.

## Context

Better Auth's magic-link plugin signs in whoever already holds an address. So a link would open a person who signed up with GitHub, without their GitHub sign-in, for anyone who controls that address now. Podster already refuses to join accounts on a matching email, because an address can move to someone else (`disableImplicitLinking`).

## Decision

**A link only signs in someone who has only ever used links.** A person with any `account` row, such as GitHub or Google, can't be reached by one. Neither can a row whose email was never proven (`emailVerified = 0`). The plugin would delete such a row's sign-ins and sessions before starting a session, so it's refused before the plugin runs. Only password sign-up, which works only on local hostnames, can make that row.

- If they ask, they get an email with no link, saying this address signs in another way. The answer to the request is the same as for anyone, so only the mailbox learns anything.
- It's checked before sending, again before the plugin runs when the link is used, because someone can sign up with GitHub while a link is on its way, and once more as the session starts.
- The reverse stays refused too: someone who started with a link and then tries GitHub on the same address gets the existing sign-in error, because implicit linking is off.

So one human with an address could need the sign-in they used first. Nothing joins two sign-ins, and there's no route that links them on purpose. That can come later, if it starts from a signed-in session.

## How a link works

- **Host:** both routes answer only on the application host, and 404 on the gateway's. Off until `ENABLE_EMAIL_SIGNIN`, the `EMAIL` binding, `EMAIL_FROM` and `APP_URL` are all set.
- **The link:** valid for 5 minutes and single-use, consumed atomically by Better Auth. Only a hash of the token is stored. The token isn't logged, and it isn't in any answer.
- **One click:** the link opens `/sign-in/email`, which spends nothing and has a button, because mail scanners open links and would use them up.
- **Only from that page:** the route that uses a token refuses anything but `Sec-Fetch-Site: same-origin`, which the page's form sends, and the token stays unspent. So a link from another site can't sign a browser in with no click. A browser that doesn't send the header, such as Safari before 16.4, can't use links, and nothing has tried a real browser yet.
- **No enumeration:** whether an address has an account doesn't change the answer. An address on the test domain or at its own limit answers 200 even while the total is at its limit and others get a 429. That shows the limit's state, not whether an account exists.
- **Timing:** sending happens after the answer. A test holds the send open and sees the answer arrive, but the claim that timing shows nothing rests on reading the code, and nobody has measured it. The paths before the answer also make different numbers of counter calls.
- **What a caller controls:** only the address, and a path on this host to return to. The route takes no name or metadata, so a new person's name is empty and their personal organization is called "Personal".
- **Test people:** their reserved domain gets no email and no token, and the sign-up hook refuses it. This uses the test sign-up's definition of that domain, and nothing else from that path.

## Limits

Fixed in code. A counter that fails refuses, because going on would send email.

| Counted | Per minute | Per day | Past it |
| --- | --- | --- | --- |
| Mailbox | 1 | 5 an hour | Same answer, nothing sent |
| Client (IP, or IPv6 /48) | 5 | 30 | 429 |
| All clients | 20 | 100 | 429 |

Both routes also count under the limit of 20 a minute per client that other sign-in routes have. A mailbox ignores anything after `+`, and Gmail's dots, for counting only. Mail goes to what was typed.

## Known limits

- **A link can be opened in any browser, so a click can still sign you in as someone else.** An attacker asks for a link to their own mailbox, then sends you the landing page's address. If you press the button, your browser is signed in as them. The page warns you, and that's all that stops it. In that state, what you do goes to them. I traced these in the code:
  - Accepting an organization invitation adds **them** to that organization, with the invited role, and spends the invitation (`acceptInvitation` in `apps/gateway/src/organizations.ts`). The `/join` screen does say "You'll join as" with their name and email, so you could notice there.
  - Approving an agent connects it to **their** organization, so its work reaches them.
  - Accepting a room invitation can only name organizations they administer, so it brings their side in.
- **Anyone can shut a link-only person out for up to an hour,** by asking five times. They have no other way in, and repeating it each hour keeps them out. It also sends them that mail, up to 5 an hour.
- **A few addresses can stop links for everyone for the rest of the day.** About four IPs, or more /48s, use up the total of 100. Link-only people then can't sign in, though GitHub sign-in still works. They can't read mail or sign in as anyone either way.
- **Invented addresses cost sending reputation.** Anyone can ask for a link to an address that doesn't exist, and each bounce counts against the domain and the month's allowance. Other providers' mailbox tricks, such as subdomains or their own dot rules, also count separately.
- **The token is in a URL,** which is what a link is. It passes through the web Worker to the gateway, so anyone with `wrangler tail` or request logs on those Workers could see one. It also sits in Email Service's preview, if that's on. It's single-use and lasts 5 minutes.

## Decisions for the owner

1. **Bind a link to the browser that asked for it?** A short-lived cookie checked at use would close the first limit above, and the invitation harm with it. The cost is that asking on a laptop and opening the mail on a phone stops working. I recommend it before production, and left it out because it changes how links feel.
2. **Should the total be 100 a day?** It protects the 3,000 a month, and it's what lets a few addresses stop links for everyone. A higher total moves that harder, and costs more if abused.
3. **Keep this ADR's rule that a link can't reach a GitHub person?**

## Not proven until staging

Real sends, whether token use stays single under real D1 (a test with eight requests at once passes on local D1), whether `cf-connecting-ip` survives the service binding, and whether real browsers send `same-origin` from the page's form.
