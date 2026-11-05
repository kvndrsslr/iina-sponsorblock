# SponsorBlock for IINA

Skip sponsor segments in YouTube videos using [SponsorBlock](https://sponsor.ajay.app/), browse them
in a sidebar, and contribute without leaving the player: set boundaries, submit segments, upvote and
downvote.

This is a port of [po5/mpv_sponsorblock](https://github.com/po5/mpv_sponsorblock) (GPL-3.0) to IINA's
plugin system. The original is an mpv Lua script with a bundled Python helper; neither works in IINA
as-is — IINA never dispatches keys to mpv script bindings. This version uses IINA's own modules:
`iina.http` for the API, `iina.menu` for native menu items and shortcuts, `iina.sidebar` for the
segment list, `iina.core` for OSD, and mpv properties for playback.

## Install

From this folder:

```sh
make test                      # unit tests for the pure logic
make link                      # symlink this directory into IINA's plugin folder
# restart IINA, then enable SponsorBlock in Settings > Plugins
make unlink                    # to remove it again
```

Or build a package and install it from IINA:

```sh
make build                     # dist/SponsorBlock.iinaplugin + dist/SponsorBlock.iinaplgz
# IINA > Settings > Plugins > Install Local Package... and pick the .iinaplgz
```

The plugin stays disabled until it is enabled once in Settings > Plugins. A "SponsorBlock" tab
appears in the sidebar and a "SponsorBlock" section in the Plugin menu while a player window is
focused.

## Behaviour

When a file loads, the plugin finds the YouTube video ID in the media URL, the HTTP referer, the
`PURL` metadata or, with `local_pattern` set, in the file name. It then requests the segments for the
configured categories and acts on the ones in `skip_categories`:

- **seek** (default): jump to the end of the segment and show `[sponsorblock] <category> skipped`;
- **fast forward**: raise playback speed by `fast_forward_increase` every second up to
  `fast_forward_cap`, restore it when the segment ends;
- **audio fade**: lower the volume in the second before a segment and bring it back afterwards.

Segments are fetched once per file load. Only the first segment wins when two overlap, segments
shorter than `min_duration` are ignored, and with `skip_once` each segment is acted on once per file.
The sidebar and the OSD show where the segments are; the timeline does not, because IINA exposes no
chapter writing without the `file-system` permission (see *Differences*).

The user ID used for votes and submissions is generated on first use and stored in the plugin's
preferences. `report_views` tells the server which segments were skipped, `auto_upvote` upvotes them,
and `display_name` sets the name shown on the SponsorBlock stats page.

## Menu and shortcuts

The Plugin menu carries the actions, with the shortcuts shown next to them. IINA displays at most
five first-level items, so everything but the main switch and the two entry points lives in a
submenu. Items are rebuilt when a file is loaded, so preference changes apply to the next file.

| Menu item | Default shortcut | Action |
| --- | --- | --- |
| Skip Segments | `b` | Checkmark reflects whether skipping is on; toggles it for the current file. |
| Segment ▸ Set Boundary | `g` | Sets boundary A, press again for boundary B, again for A, … |
| Segment ▸ Clear Boundaries | — | Drops the pending A/B pair and its preview chapters. |
| Segment ▸ Submit | `G` | Submits the A/B range as Sponsor. |
| Segment ▸ Submit As ▸ | — | Same, with one item per SponsorBlock category. |
| Vote ▸ Upvote Last | `h` | Upvotes the last segment that was skipped. |
| Vote ▸ Downvote Last | `H` | Downvotes the last segment that was skipped. |
| Show Segments | `Meta+Shift+b` | Opens the sidebar tab. |
| Refresh Segments | — | Fetches the segment list again. |

Items that need a YouTube video (boundaries, submit, refresh) are disabled otherwise, and upvote and
downvote are disabled until a segment has been skipped. Shortcuts are mpv key names; the defaults are
free in IINA's own key binding table, so IINA hands them to the menu item instead of to a player
command.

## Sidebar

The "SponsorBlock" sidebar tab shows the state of the current file and is fully interactive:

- a switch for skipping in the current file;
- every segment with its time range and category, marked as current or already skipped, with a play
  button that seeks to the segment start and upvote/downvote buttons that mark what you voted;
- a "New segment" section with the pending A/B boundaries, a button that sets the next boundary at the
  current position, a category picker and submit, plus a clear button;
- a status line (fetching, segment count, server unreachable) and refresh.

On anything that is not a YouTube video the tab shows a single line, `No YouTube Video detected`, and
nothing else.

## Preferences

Settings > Plugins > SponsorBlock > Preferences. Defaults match the upstream script.

| Key | Default | Meaning |
| --- | --- | --- |
| `server_address` | `https://sponsor.ajay.app` | API server or mirror. |
| `categories` | `sponsor,intro,outro,interaction,selfpromo,filler` | Categories to fetch. |
| `skip_categories` | `sponsor` | Categories to act on (subset of the fetched ones). |
| `skip` | `true` | Skip automatically; the menu item toggles it per file. |
| `skip_once` | `true` | Act on each segment at most once per file. |
| `min_duration` | `1` | Ignore segments shorter than this many seconds. |
| `sha256_length` | `4` | 3–32 hashes the video ID down to that many hex characters (privacy mode); 0 sends the plain ID. |
| `local_pattern` | empty | JS regular expression whose first group is the 11 character video ID, for local files. |
| `fast_forward` | `false` | Speed up through segments instead of seeking. |
| `fast_forward_increase` | `0.2` | Speed added per second. |
| `fast_forward_cap` | `2` | Speed limit. |
| `audio_fade` | `false` | Fade audio around segments. |
| `audio_fade_step` | `10` | Volume changed every 100 ms. |
| `audio_fade_cap` | `0` | Lowest volume during a fade. |
| `report_views` | `true` | Report skipped segments to the server. |
| `auto_upvote` | `false` | Upvote skipped segments. |
| `user_id` | empty | Contributor ID; generated when empty. |
| `display_name` | empty | Name on the SponsorBlock stats page. |
| `toggle_key`, `set_segment_key`, `submit_segment_key`, `upvote_key`, `downvote_key`, `sidebar_key` | `b`, `g`, `G`, `h`, `H`, `Meta+Shift+b` | Menu shortcuts. |

## Differences from the upstream script

- No Python helper: the API calls use `iina.http`, with SHA-256 implemented in JavaScript for the
  hash-prefix mode. There is no external dependency and no `file-system` permission.
- Instead of the OSD prompt with numbered keys, categories are picked from the `Submit Segment As`
  submenu or the sidebar's category picker.
- `local_pattern` takes a JavaScript regular expression instead of a Lua pattern (upstream's default
  is empty, so the recommended yt-dlp naming needs `-([A-Za-z0-9_-]{11})\.[A-Za-z0-9]+$`).
- `local_database`, `auto_update`, `auto_update_interval` and `server_fallback` are not ported. The
  upstream script hardcodes `options.local_database = false` before doing anything with them, so a
  local database — and the code paths that only exist for it — never run there either.
- Chapter boundary markers (`make_chapters` upstream) are not ported: mpv's `chapter-list` property is
  not on IINA's allowlist of safe options, so writing it would require the `file-system` permission —
  a permission that would let the plugin read or execute anything. The plugin asks only for
  `show-osd` and `network-request`, and every mpv call is wrapped so a refused property cannot abort
  it.
- `allowedDomains` is `sponsor.ajay.app`. Pointing `server_address` at a mirror therefore needs that
  domain added to `Info.json` as well.
- Don't run the upstream Lua script at the same time: it would fetch and skip in parallel with the
  plugin.

## Licence

GPL-3.0, following po5/mpv_sponsorblock and jouni/mpv_sponsorblock_minimal. Segment and vote data is
provided by the SponsorBlock project.
