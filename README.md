# EasyView: accessibility browser extension (v1.1)

EasyView makes existing websites easier to use for older adults, people with low vision or
reading difficulties, and anyone less comfortable with technology. It works on top of any site
without the site being redesigned. The core extension needs no account, backend or paid service.

## Features
Comfort Mode (one click, still customisable, with its own text-size slider) · text size 80–200%
with A−/A+ buttons and a slider · Original / Light / Dark / High-contrast colours · readable font ·
line, letter and paragraph spacing · easy-to-find cursor (big pointer + orange ring) · Read Aloud
(Play / Pause / Resume / Stop, reads selected text or the page's main text) · Focus Mode (stops
animation, hides ads, fades side panels) · per-website saved settings · Reset All.

## What's new in 1.1
- **Images no longer disappear in colour modes.** Only solid, image-free backgrounds are recoloured.
  Elements with a background image keep their own colours, the page `<body>` is transparent, and
  transparent logos get a light or dark plate so they stay visible.
- **Comfort Mode text size is adjustable** with a slider (100–200%, default 120%). It is saved once
  and used on all websites. The Text size section also has a live slider.

## Install (Chrome or Edge)
1. Put all the files in one folder named `easyview` (keep the `icons` sub-folder).
2. Open `chrome://extensions` (Edge: `edge://extensions`).
3. Switch on **Developer mode**.
4. Click **Load unpacked** and choose the `easyview` folder.
5. Click the puzzle-piece icon in the toolbar and **pin** EasyView.
6. Optional, for local `.html` files: Details on the extension, then **Allow access to file URLs**.
After editing any file, click the circular reload arrow on the extension's card, then reload the page.

## How it works
- `content.js` runs on every page, owns that website's settings and applies them by adding
  `ev-*` classes to `<html>`.
- `accessibility.css` contains every style. Rules only apply under those classes.
- For colour modes, `content.js` first reads the page's own colours and tags elements:
  `data-ev-bg` (solid background: may be recoloured), `data-ev-keep` (has a background image:
  left alone). Everything else, including images, is untouched.
- `popup.js` is a remote control. It asks `content.js` for the current state and redraws it.
- Settings are saved in `chrome.storage.local`: `easyviewSites` (one entry per website origin) and
  `easyviewComfortScale` (one global Comfort Mode text size).

Messages (popup to page): `EV_GET_STATE`, `EV_UPDATE {patch}`, `EV_COMFORT {enabled}`,
`EV_COMFORT_SCALE {value}`, `EV_TEXT_SIZE {action}`, `EV_RESET`, `EV_READ {action}`.
Page to popup: `EV_READER_CHANGED`.

## Permissions and privacy
- `storage`: save your settings on your own computer.
- `activeTab` + `scripting`: only used to inject EasyView into a tab that was already open before
  installation, after you click the toolbar icon.
- Content script on all `http(s)` pages: needed so saved settings apply automatically. It only
  changes the page's appearance.
- EasyView sends nothing over the network. No analytics, no tracking, no history collection.
  Read Aloud uses your browser's built-in voices.

## Testing checklist
1. **Load**: install via `chrome://extensions`; no errors on the extension card; icon appears.
2. **Each setting on/off**: toggle every switch and confirm the page changes and the switch shows
   On/Off. Confirm Comfort Mode switches on bigger text, light colours, readable font and spacing,
   and that you can then change any single setting.
3. **Text size**: press A+ repeatedly (stops at 200%), A− repeatedly (stops at 80%), drag the
   slider, then Reset. The page must return to exactly its original size; no drifting after repeats.
4. **Comfort Mode slider**: move "Comfort Mode text size" to e.g. 150% with Comfort Mode on: the page
   updates live. Turn Comfort Mode off and on again: it uses 150%. Open another website: also 150%.
5. **Colours and images**: switch Original, Light, Dark, High contrast and back on a page with photos,
   a banner image, a slideshow and a logo. Every image must stay visible; links readable.
6. **Persistence**: change several settings, reload, reopen the popup; they must match. A different
   website starts with its own default settings.
7. **Reset All**: page and popup return to default, and stay default after reload.
8. **Read Aloud**: Play (it must NOT start by itself). Pause, Resume, Stop. Select a paragraph and
   press Play to hear only the selection. Use the on-page Pause/Stop bar after closing the popup.
9. **Focus Mode**: animations stop, ad slots disappear, side panels fade. Forms, search, navigation
   and payment buttons stay visible and usable. "Exit Focus Mode" on the page and the popup switch
   both turn it off.
10. **Real-world pages**: a page with a form, a menu, many images, and a dynamic/infinite-scroll page
    (new content must also scale and be themed).
11. **Restricted pages**: open the popup on `chrome://extensions`, a new tab and the Chrome Web Store:
    a friendly message appears with locked controls and no crash.
12. **Console**: press F12 on the page and right-click, Inspect on the popup; no red EasyView errors.

## Known limitations
- Only the top frame of a page is changed (not embedded iframes).
- Colour modes: text on top of a background image keeps the site's own colours (by design, so it
  stays readable on the image). Inline `<svg>` icons that use fixed dark colours can be hard to see on
  dark themes. Elements that gain a solid background only after a hover, or through a style change
  that is not a class change, may not be recoloured.
- Text size uses each element's original pixel size multiplied by the scale. Pages that change font
  sizes with screen width may need a reload after resizing. Very large sizes can make fixed-width
  layouts overflow.
- The readable-font rule skips common icon fonts, but unusual icon libraries may show boxes.
- Read Aloud quality depends on the voices installed on your computer. Text inside iframes or
  images is not read.
- Focus Mode uses common ad and sidebar patterns; it cannot recognise every distraction.
- Chrome Web Store, `chrome://` pages, the PDF viewer and other browser pages cannot be modified.

## Troubleshooting
| Problem | Likely cause | Fix |
|---|---|---|
| "Could not load manifest" / icon error | Missing or misnamed files | Check the folder structure, including `icons/icon16.png`, `icon48.png`, `icon128.png` |
| Popup says it cannot connect | Page restricted, or file URL access is off | Use a normal website; enable "Allow access to file URLs" for local files; reload the page |
| Changes do nothing after editing code | Extension not reloaded | Click reload on the extension card, then reload the page |
| An image is still missing in a colour mode | An unusual page structure | Note the website and which mode; use the Original colour button to confirm it is the colour mode |
| Read Aloud is silent | No voice for the page language, or system volume | Try an English page; check Windows speech settings and volume |
| Settings did not persist | Different origin (www vs non-www, http vs https) | Settings are saved per origin by design |

## Adding AI features later (not included)
No AI code is shipped, so nothing here pretends to work. To add it safely:
1. Add a handler (for example `EV_AI_SIMPLIFY`) to the `handlers` object in `content.js`.
2. Send only text the user explicitly selected, after a clear on-screen disclosure.
3. Call your own small backend (for example a serverless function) that holds the API key. Never put
   an API key in any extension file. Request that backend's address as an *optional host permission*.
4. Show the result in a separate panel labelled "Simplified explanation (AI)" next to the
   untouched original. Never replace legal, financial or medical text.
5. If the backend is unreachable, show a plain message. The rest of EasyView keeps working.

## Accessibility claim
EasyView has been designed with accessibility in mind but has not been audited. It does not claim
WCAG compliance. Please test with real users.