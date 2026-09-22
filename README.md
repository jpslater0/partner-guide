# partner-guide

One page: **`live/`**, served at
<https://jpslater0.github.io/partner-guide/live/>.

It is generated. Edit `live/data.json`, then run `node live/build.mjs`.
See [live/README.md](live/README.md) for the build, the checks and where the
figures come from.

## Removed 2026-09-22

`index.html`, `guide/` and `howto/` were version one and are gone. The root
URL and both page URLs now 404 by choice. They are in git history if they are
ever wanted: `git log --diff-filter=D --stat` to find the commit, then
`git checkout <commit>^ -- guide howto index.html`.
