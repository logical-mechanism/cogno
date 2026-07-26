# Content and abuse policy

This covers <https://cogno.forum>, the operator-hosted frontend for the cogno-chain preprod testnet,
and the chain behind it. Read it before you post: what you publish here cannot be taken back.

## Content is permanent

There is no delete. The protocol has no `delete_post` call — it was removed, and its call index is
permanently vacant. A post, a reply, a quote, a vote, a profile field: once it is in a block, it is in
every copy of the chain, forever.

**Nobody can remove it from the chain.** Not you. Not the 3-of-5 committee. Not the operator. There is
no edit and no expiry. Anyone can run a node and read the whole history. Taking the hosted site down
would not unpublish a single byte. The operator *can* stop serving a post from <https://cogno.forum>
(see "the two levers" below), which changes what this site shows and changes nothing about the record.

Do not post anything you would need removed later — personal information, anything illegal where you
live, anything you would not want attached to your Cardano identity permanently.

## The two levers that exist

**1. Revoke, on the chain.** The committee (a 3-of-5 vote, `pallet-cogno-gate`'s `revoke`) can
**tombstone an identity**: the account can no longer post, and neither that Cardano identity nor its
stake key can ever bind again. It is permanent — a ban means a ban. It is also forward-only: revoking
an account stops the next post and does not touch the ones already published.

**2. Delist, on this site.** The hosted frontend at <https://cogno.forum> ships a build-time denylist
of accounts and post ids it declines to render (`app/src/lib/config/denylist.ts`, applied at the single
read seam in `app/src/lib/feed/denylist-source.ts`). Delisting an account omits its posts, replies,
quotes, profile, search and who-to-follow rows, and its mentions inside other people's posts; delisting
a post omits that one item.

That lever is **not** moderation of the chain, and the difference is the whole point. The post is still
in every block, every node still serves it, and the same app pointed at a different endpoint shows the
complete record. What it changes is who is doing the serving. That is a real thing to be able to do, it
is what a takedown notice can actually compel, and it is meaningfully less than "removed".

The denylist ships **empty**, and it is not secret: a static export inlines it into the JavaScript
bundle, so anyone can read what this deployment has delisted. A hidden list of quietly-dropped content
would be worse than a visible one.

There is **no third lever**, and there will not be one. Nothing can edit, hide or delete a post on the
chain, for anyone, under any order.

## Images

The chain stores text. A post can contain a URL that points at an image on an arbitrary host the
operator does not control. The frontend never auto-fetches these: they render behind a click-to-reveal
cover, so nothing loads until you choose to load it. That is a defense for you, the reader — it is not
moderation, and it does not vet what is on the other end.

## What you can do as a reader

Every post's `···` menu carries **Hide post**, **Mute** and **Block**, and Settings lists what you have
muted, blocked and hidden. All three are **device-local**: they live in your browser, apply only to you,
and are not on the chain — a public chain cannot keep a private mute list. Mute collapses a post to a
"Show" stub; hide and block REMOVE the item from your lists entirely. None of them removes it for anyone
else. Bookmarks and lists are device-local for the same reason.

## Who may use this

You must be at least **13** years old. If you are under the age of majority where you live, get
permission from a parent or guardian first. Locking ADA in the vault is a transaction with a real
contract, so you must also be old enough to enter one where you live.

## Reporting abuse

Email **support@logicalmechanism.io**. Every post's `···` menu has a **Report post** action that opens
that email with the permalink already filled in, and the same address is on the in-app policy page
(`/policy`) and under Settings → About. For a security vulnerability use [SECURITY.md](SECURITY.md)
instead.

What the operator can actually do about a report:

- Bring a revoke motion to the committee, which stops the account from posting again.
- Delist the post or the account from cogno.forum — the site is a client, not the record.
- Comply with a valid legal order to the extent it is technically possible, which is those two things.

What the operator **cannot** do, for anyone, under any order:

- Remove, edit, or hide a post from the chain. The capability does not exist.
- Recover or reverse anything already published.

If that is not an acceptable posture for you, do not use this network. It is honestly labeled, and this
constraint is a deliberate design choice, not an oversight.

## Delisting, for whoever runs a deployment

The serve lever is build-time configuration, so applying it is a rebuild and a redeploy of the static
export. Nothing on the chain moves and no key is used.

```bash
# from app/ — comma-separated, and BOTH may be set
NEXT_PUBLIC_DENY_AUTHORS=5Grw…utQY,5FHn…9xKp \
NEXT_PUBLIC_DENY_POSTS=1234,5678 \
  npm run build
sudo rsync -a --delete out/ /var/www/cogno/
```

A malformed entry **fails the production build** rather than being skipped: a denylist that silently
drops a typo is worse than none, because the deploy goes out green while the content is still served.
Removing an entry and rebuilding un-delists it. The list is inlined into the bundle and is therefore
public, by design.

Anyone running their own deployment sets their own list, or none. That is the same neutrality argument
as the configurable endpoint: this repository ships the mechanism, not a set of decisions.
