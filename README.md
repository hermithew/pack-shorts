# Pack Shorts

Turn a pack-opening video into a vertical Short with a price box for every card you pull, a running
**pack total**, tier colours (nice / HIT! / BIG HIT! / JACKPOT!), sound effects and an end card with your profit.

Pack Shorts is a phone web app (PWA). Install it from the browser and it works like a normal app. Everything happens
**on your phone**:

1. Pick a pack-opening video from your phone.
2. Pick the pack you're opening (e.g. "Murders at Karlov Manor Play Booster", "Zendikar Rising Draft Booster") so the
   app uses exactly the cards that can be in it. Or enter set code(s) (`dsk`, `dsk,spg`, `sld:1650-1660`), or start
   typing a Secret Lair drop name. You can also add the pack price.
3. The app recognises each card by its artwork. You can also have it **listen for the card names you say**. Saying
   "foil" right before or after a name marks that card as foil.
4. Check the list: tap a time to jump to that card, toggle ★ Foil, remove a card, type your own price, or add a card it
   missed.
5. Drag the pack-total box and the card box where you want them. The Shorts, TikTok and Reels look-alike overlays show
   what the app buttons would cover.
6. Tap **Make Short**, then download it or share it straight to your gallery or an app.

## Put it on GitHub Pages

The app is plain static files, so there's no build step.

1. Fork or push this repository to your account, e.g. `your-username/pack-shorts`.
2. On GitHub, go to **Settings → Pages → Build and deployment**, choose **Deploy from a branch**, then branch **main**
   and folder **/ (root)**, and save.
3. After a minute it is live at `https://your-username.github.io/pack-shorts/`.

All paths in the app are relative, so it works under any sub-path. It needs HTTPS (GitHub Pages provides it), because
service workers, the camera roll share sheet and screen wake lock only work on secure origins.

To try the screens without scanning anything, add `?mock=1` to the address. It uses built-in demo data instead of
the internet.

## Install on Android

Open the GitHub Pages address in **Chrome** or **Brave**, open the **⋮ menu**, and tap **Install app** (or **Add to Home
screen**). Pack Shorts then gets its own icon and opens full-screen.

On iPhone, use Safari's **Share → Add to Home Screen**. iPhone support is best-effort.

## First-run downloads

The app is small, but some things are downloaded the first time you need them and then kept on the phone:

| What | Size | When |
|---|---|---|
| The app itself, including OpenCV for card recognition | ~13 MB | first visit (cached for offline use) |
| Speech model for "Listen for card names I say" | ~80–150 MB | first time you use voice |
| Card list and card pictures for a set | about 20 KB of matching data per artwork | first scan of that set, or ahead of time with **Download ahead** (one picture per artwork is downloaded, turned into matching data, then deleted; lists refreshed monthly; prices of the cards found are refreshed after every scan) |
| Secret Lair drop list | ~1 MB | first drop search (refreshed weekly) |
| List of booster contents (~1,000 products) | ~10 MB | first pack search (refreshed weekly) |
| Working copy of the video you're working on | same size as the video | while you work on it (only the latest one is kept) |
| Finished Shorts | usually 20–150 MB each | kept with their job until you delete the job, re-make it, or tap **Delete saved Shorts** |

After that, the app opens and works offline for sets you've already scanned. Prices refresh when you're online.

## Updates

When a new version is published, an open app shows **"A new version of Pack Shorts is ready"** with a **Refresh** button.

To publish an update: change the files, **bump `VERSION` in `sw.js`** (e.g. `'v1'` → `'v2'`), and push. The new service
worker downloads the new files in the background and waits. When the user taps Refresh, it takes over, clears the old app
cache and reloads. Card-art and speech-model caches are kept.

## Privacy

- Your videos never leave your phone. Nothing is uploaded, and there's no server or account.
- Card lists, settings and box positions are stored in the browser's storage on your phone. Delete a job from **Recent**
  to remove it.
- When you pick a video, the app makes one private working copy of it inside its own storage on the phone. Android can
  otherwise take away access to a picked video partway through a long job. Only the latest video is kept, and you can
  delete it under **Storage on this phone**. For older jobs you'll be asked to pick the video again.
- Each finished Short is kept in the app's storage with its job, so it's still there if you leave the app. Deleting the
  job deletes it too.
- The app asks the browser to protect its storage from automatic clean-up. If the browser says no, card lists and
  pictures may be cleared when the phone runs low on space; installing the app to the home screen usually fixes that.
- Network requests go only to Scryfall (card data and pictures), MTGJSON (Secret Lair drop names), GitHub
  (raw.githubusercontent.com, booster contents), and, if you use voice, jsDelivr and Hugging Face (speech recogniser and model).

## Credits & licences

Made by hermithew — MIT licensed (see `LICENSE`).

- **OpenCV.js** (card recognition) — Apache License 2.0, see `lib/LICENSE-opencv-js.txt`.
- **mp4-muxer** and **webm-muxer** by Vanilagy — MIT, see `lib/LICENSE-mp4-muxer.txt` and `lib/LICENSE-webm-muxer.txt`.
- **Transformers.js** by Hugging Face — Apache License 2.0, loaded at runtime from cdn.jsdelivr.net. Whisper speech
  models from huggingface.co.
- Booster contents (which cards can be in each product) from **[mtg.wtf](https://mtg.wtf)**'s open data,
  [taw/magic-sealed-data](https://github.com/taw/magic-sealed-data). It's downloaded at runtime, not copied into this repository.
- Card data and card images from **[Scryfall](https://scryfall.com)**. Please respect their
  [API guidelines](https://scryfall.com/docs/api). Secret Lair drop names from **[MTGJSON](https://mtgjson.com)**.
- The platform look-alike overlays are generic drawings for positioning only. They're not the apps' real artwork.

Pack Shorts is unofficial Fan Content permitted under the Wizards of the Coast Fan Content Policy. It is not
approved or endorsed by Wizards. Portions of the materials used are property of Wizards of the Coast. ©Wizards of the Coast LLC.
Prices are estimates from Scryfall and are not financial advice.

## For developers

- No bundler and no npm: plain ES modules. `index.html` loads `js/app.js`, which uses `js/data.js`, `js/detect.js`,
  `js/voice.js`, `js/voice-match.js`, `js/render/*` and `js/media/*`. `js/tiers.js` is shared.
- `?mock=1` swaps every worker module for `js/mocks.js`, which uses fake data and no network.
- `?api=http://host:port` points the card data at a mock Scryfall/MTGJSON server for testing.
