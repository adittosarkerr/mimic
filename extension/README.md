# Mimic extension

## Build

```
npm install
npm run build
```

## Load in Chrome

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked**
4. Select the **`extension/dist`** folder — NOT the `extension` folder itself.
   (The root folder has no manifest, so Chrome will reject it — that's intentional.)
5. Pin "Mimic — Web Task Recorder" from the puzzle-piece menu.

After every rebuild (`npm run build`), press the reload icon on the extension card in `chrome://extensions`.

## Use

1. Click the Mimic toolbar icon → press the round record button.
2. A floating "mimic" pill appears bottom-right of every page while recording.
3. Do the task normally (clicks, typing, multiple sites all fine).
4. Press **Stop** on the pill (or in the popup).
5. Press **review & build** in the popup — this sends the recording to the backend
   (`cd ../backend && npm run dev` must be running, port 4545).
