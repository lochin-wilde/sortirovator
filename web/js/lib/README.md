# Vendored libraries

These are served from our own origin rather than a CDN. Both run with access to
the user's audio — lamejs inside the worker that holds decoded samples, jszip on
the main thread with every loaded file — so which exact bytes run is not a
decision to hand to a third party who can change them at any time. Same-origin
also means MP3 export and ZIP building keep working offline.

| file | version | license | upstream |
|---|---|---|---|
| `lame.min.js` | lamejs 1.2.1 | **LGPL-3.0** | https://github.com/zhuker/lamejs |
| `jszip.min.js` | jszip 3.10.1 | MIT *or* GPL-3.0-or-later | https://github.com/Stuk/jszip |

SHA-256 of what is committed here:

```
15d285e2587b3bdbfd18a68de6ce07cc074f7480a82c3815da2dc1c348ec6df4  lame.min.js
acc7e41455a80765b5fd9c7ee1b8078a6d160bbbca455aeae854de65c947d59e  jszip.min.js
```

## Updating

Replace the file, re-check the hash, bump the app version in both `index.html`
and `js/app.js`. There is no package manager step — that is deliberate: an
update becomes a decision someone makes and records, not something that happens
to the app overnight.

```bash
curl -s https://cdn.jsdelivr.net/npm/lamejs@1.2.1/lame.min.js -o lame.min.js
shasum -a 256 lame.min.js
```

## The LGPL condition

lamejs is LGPL-3.0, which is worth knowing before this is distributed. Using it
unmodified as a separate file, as we do, is the case the licence is written for:
keep the file intact, keep this attribution, and say where the source is. What
LGPL asks in return is that a user who wants to swap in their own build of the
library can do so — which they can, since it is one file served by path.

Modifying `lame.min.js` in place, or merging it into a bundle with our own code,
is what would raise real obligations. Don't.

The app's own code carries no such condition; jszip's MIT option carries none
either.
