# Content and abuse policy

This covers <https://cogno.forum>, the operator-hosted frontend for the cogno-chain preprod testnet,
and the chain behind it. Read it before you post: what you publish here cannot be taken back.

## Content is permanent

There is no delete. The protocol has no `delete_post` call — it was removed, and its call index is
permanently vacant. A post, a reply, a quote, a vote, a profile field: once it is in a block, it is in
every copy of the chain, forever.

**Nobody can remove it.** Not you. Not the 3-of-5 committee. Not the operator. There is no takedown
path, no edit, no expiry. Anyone can run a node and read the whole history. Taking the hosted site
down would not unpublish a single byte.

Do not post anything you would need removed later — personal information, anything illegal where you
live, anything you would not want attached to your Cardano identity permanently.

## The only lever that exists

The committee (a 3-of-5 vote, `pallet-cogno-gate`'s `revoke`) can **tombstone an identity**: the
account can no longer post, and neither that Cardano identity nor its stake key can ever bind again.
It is permanent — a ban means a ban.

It is also the *only* moderation primitive, and it is forward-only. Revoking an account stops the
next post. It does not touch the ones already published.

## Images

The chain stores text. A post can contain a URL that points at an image on an arbitrary host the
operator does not control. The frontend never auto-fetches these: they render behind a click-to-reveal
cover, so nothing loads until you choose to load it. That is a defense for you, the reader — it is not
moderation, and it does not vet what is on the other end.

## What you can do as a reader

Mute and hide are **device-local**. They live in your browser, apply only to you, and are not on the
chain — a public chain cannot keep a private mute list. They collapse content in your view; they do
not remove it for anyone else.

## Reporting abuse

Email **support@logicalmechanism.io**. For a security vulnerability use [SECURITY.md](SECURITY.md)
instead.

What the operator can actually do about a report:

- Bring a revoke motion to the committee, which stops the account from posting again.
- Change what the hosted frontend at cogno.forum shows — the site is a client, not the record.
- Comply with a valid legal order to the extent it is technically possible.

What the operator **cannot** do, for anyone, under any order:

- Remove, edit, or hide a post from the chain. The capability does not exist.
- Recover or reverse anything already published.

If that is not an acceptable posture for you, do not use this network. It is a testnet, it is honestly
labeled, and this constraint is a deliberate design choice, not an oversight.
