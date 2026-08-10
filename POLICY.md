# Content and abuse policy

This covers <https://cogno.forum>, the operator-hosted frontend for the cogno-chain preprod testnet,
and the chain behind it. Read it before you post: what you publish here cannot be taken back.

## Content is permanent

There is no delete. The protocol has no `delete_post` call — it was removed before launch, and its
call index is permanently vacant. A post, a reply or a quote is final: there is no edit and no expiry.
A few things do change going forward — a profile field can be overwritten or cleared, a vote can be
retracted — but each of those is a new entry in a later block, not a correction of the earlier one.

Either way, once something is in a block it is in every copy of the chain, forever. **Nobody can
remove it from the chain.** Not you. Not the 3-of-5 committee. Not the operator. Anyone can run a node
and read the whole history. Taking the hosted site down would not unpublish a single byte. The
operator *can* stop serving a post from <https://cogno.forum> (see "On this site, not on the chain"
below), which changes what this site shows and changes nothing about the record.

Do not post anything you would need removed later — personal information, anything illegal where you
live, anything you would not want attached to your Cardano identity permanently.

## What can actually be done, and to whom

Every privileged action on this chain is a committee motion, carried by at least three fifths of the
committee's seats. There is no sudo key, no root origin and no operator override — the committee is the
whole of it, and the list below is the whole of what it reaches. Read the list as one sentence: **every
one of these governs what happens next, and none of them touches what has already been published.**

### On the chain, against a named account

**Revoke an identity.** `pallet-cogno-gate`'s `revoke` — or `revoke_many`, the same teardown over up
to 64 accounts in one motion — unbinds an account and permanently tombstones the Cardano identity
behind it. The account can no longer post, and that identity can never bind again: the tombstone is
never lifted, so replaying an otherwise-valid CIP-8 proof is refused for ever. If the account still
holds a stake key bound for voting weight, that credential is tombstoned along with it, so the same
stake cannot be re-bound under a fresh identity.

**Tombstone a stake credential.** `tombstone_stake_cred` names a Cardano stake credential directly and
bans it from being bound, with no account involved at all. It exists because releasing your own stake
bind is a self-service call and a committee motion is public for as long as it takes to reach
threshold: without this, an account could unbind ahead of a ban and re-bind the same stake key to a
new identity. It bans the credential going forward; it does not unbind anything by itself.

**Revoke a verified role.** `pallet-cardano-roles`' `revoke_role`, and `revoke_role_many` for up to 64
pairs in one motion, strips an account's SPO, dRep or constitutional-committee tag, tombstones the
credential that proved it, and drops that account's badges and whatever governance-poll weight they
carried, in the same block. It does not affect posting.

**Reset a posting battery.** `Microblog::force_set_capacity` writes an account's capacity bucket, up or
down. It is clamped to what that account's locked ADA already backs, so it cannot mint voice above the
stake behind it, and capacity regenerates on its own afterwards either way.

**Burn an account's administrative fuel.** `GovernanceFuel::revoke` names an account, stops its fuel
regenerating and burns whatever spendable balance it is holding. Fuel is the admin-side budget the
committee grants for fee-bearing calls like a validator's `set_keys`; it is non-transferable, it can
never be posted with, and an ordinary account holds none of it. So this touches nothing a reader sees
and it cannot touch posting, which is feeless and metered by locked ADA rather than by balance. It
cannot be aimed at a currently seated committee member at all — unseat first.

Those are the calls that name a user's account or credential. The rest of what the committee can do is
operations rather than moderation: granting the administrative fuel a seated member needs, seating and
unseating validators, seating and unseating itself, and authorizing a runtime upgrade.

### Chain-wide

**Pause a call.** `pallet-tx-pause` is the break-glass. The committee can disable one call for
everybody, and posting is one of the calls it can disable — the exempt list is short and exists so a
pause cannot brick the chain or lock in its own undo: the Cardano observation inherent, the timestamp,
the committee itself, and the upgrade path. It is an emergency switch for an exploit, it lands on
everyone equally, and the same committee reverses it. It stops the next post; it does not touch a
published one.

**Freeze weight observation.** `CardanoObserver::set_enforcement` stops the chain writing new
Cardano-derived weight. That changes what posting power everyone accrues from their locked ADA. It
moderates nothing and names nobody.

### On this site, not on the chain

**Delisting.** This deployment can decline to render specific accounts and post ids. The list lives in
`app/src/lib/config/denylist.ts` and is applied at the app's main feed-read seam,
`app/src/lib/feed/denylist-source.ts`, so every surface that reads through it inherits it; the handful
of reads that go around that seam — notifications, the governance poll list, the profile page, the name
and avatar behind a mention — apply the same list themselves. Delisting an account omits its posts,
replies, quotes, profile, search and who-to-follow rows, and suppresses the name and avatar shown
wherever somebody else's post mentions them (the mention text is part of that permanent post, so it
still renders and still links). Delisting a post omits that one item.

That lever is **not** moderation of the chain, and the difference is the whole point. The post is still
in every block and every node still serves it, so anyone who runs a node — or builds this open-source
app themselves — reads the complete record. Repointing the endpoint in this site's own Settings does
not restore it: the delisting travels with the bundle this site serves you. What it changes is who is
doing the serving. That is a real thing to be able to do, it is what a takedown notice can actually
compel, and it is meaningfully less than "removed".

It ships **empty**, and it is not secret. There are two ways to add an entry (see the last section) and
both end up publicly readable — the build-time list is inlined into the JavaScript bundle, and the
runtime list is a JSON file this site serves at `/denylist.json`. A hidden list of quietly-dropped
content would be worse than a visible one.

### What none of it does

Nothing edits, hides or deletes a post on the chain, for anyone, under any order. No call in this
runtime does it, so there is no motion to bring and no order to comply with. Adding one would take a
committee-authorized runtime upgrade — public, version-checked, and permanent in the chain's own
history — and even that reaches only what nodes hold as current state, never the blocks already
written. Even a revoke is forward-only: it stops the next post and leaves every earlier one exactly
where it was. And a block, once produced, is not rewritten by anything that happens afterwards — the
extrinsic that carried your post sits in that block in every archive copy of the chain.

## Images

The chain stores text. A post can contain a URL that points at an image on an arbitrary host the
operator does not control. The frontend never auto-fetches those: they render behind a click-to-reveal
cover, so nothing loads from that host until you choose to load it. Revealing one keeps it revealed for
the rest of the browsing session, everywhere it appears, until you re-cover it or reload. That is a
defense for you, the reader — it is not moderation, and it does not vet what is on the other end.

## What you can do as a reader

The `···` menu on somebody else's post carries **Hide post**, **Mute** and **Block**, and Settings
lists what you have muted, blocked and hidden. All three are **device-local**: they live in your
browser, apply only to you, and are not on the chain — a public chain cannot keep a private mute list.
Mute collapses a post to a "Show" stub; hide and block REMOVE the item from your lists entirely. None
of them removes it for anyone else. Bookmarks and lists are device-local for the same reason.

## Who may use this

You must be at least **13** years old. If you are under the age of majority where you live, get
permission from a parent or guardian first. Locking ADA in the vault is a transaction with a real
contract, so you must also be old enough to enter one where you live.

## Reporting abuse

Email **support@logicalmechanism.io**. Somebody else's post carries a **Report post** action in its
`···` menu that opens that email with the permalink already filled in, and the same address is on the
in-app policy page (`/policy`, readable signed-out, no wallet needed) and under Settings → About. For a
security vulnerability use [SECURITY.md](SECURITY.md) instead.

What the operator can actually do about a report:

- Bring a revoke motion to the committee, which stops that account from posting again and bans the
  Cardano credentials behind it.
- Bring a role-revoke motion, if the complaint is about a verified SPO or dRep tag rather than a post.
- Delist the post or the account from cogno.forum — the site is a client, not the record.
- Comply with a valid legal order to the extent it is technically possible, which is the actions listed
  under "What can actually be done, and to whom" and nothing further — none of which removes anything
  already published.

What the operator **cannot** do, for anyone, under any order:

- Remove, edit, or hide a post from the chain. No call in this runtime does it, and nothing at all
  reaches a block that is already written.
- Recover or reverse anything already published.

If that is not an acceptable posture for you, do not use this network. It is honestly labeled, and this
constraint is a deliberate design choice, not an oversight.

## Delisting, for whoever runs a deployment

There are two lists and they are **unioned**, so pulling an entry out of one does not un-delist what
the other still names. [`deploy/README.md`](deploy/README.md) carries the operational detail.

**The fast one is a runtime file**, fetched by the app on every page load and served by nginx from
`/etc/cogno/denylist.json`, outside the export root so a deploy cannot wipe it. Editing it applies on
the next page load: no rebuild, no key, and nothing on the chain moves.

```bash
# as root, on the host serving the export
sudo install -d -m 0755 /etc/cogno
sudo tee /etc/cogno/denylist.json <<'JSON'
{"authors": ["5Grw…utQY"], "posts": ["1234"]}
JSON
```

It is deliberately fail-open: an absent or unreadable file is the normal state and leaves the site
serving whatever the build-time list does not already deny. A malformed entry inside it is dropped with
a console error and never takes the site down, so check the console after an edit — a dropped entry is
still being served.

**The durable one is build-time configuration**, inlined at `next build`. It is slower to apply because
it needs a redeploy, but it cannot 404, cannot fail to load, and survives rebuilding the host from
scratch.

```bash
# from app/ — comma-separated, and BOTH may be set
NEXT_PUBLIC_DENY_AUTHORS=5Grw…utQY,5FHn…9xKp \
NEXT_PUBLIC_DENY_POSTS=1234,5678 \
  npm run build
sudo rsync -a --delete out/ /var/www/cogno/
```

On this path a malformed entry **fails the production build** rather than being skipped: a denylist
that silently drops a typo is worse than none, because the deploy goes out green while the content is
still served. Addresses must be checksum-valid and at ss58 prefix 42; post ids are decimal. Removing an
entry and rebuilding un-delists it.

Anyone running their own deployment sets their own lists, or none. That is the same neutrality argument
as the configurable chain endpoint: this repository ships the mechanism, not a set of decisions.
