# Home agent setup (old Android phone, or any always-on machine on the home Wi-Fi)

The agent is optional. Tenergy works without it, from Tuya's cloud. With it you get:
- **live readings** straight from the plugs over the home Wi-Fi (every ~10 s, and no Tuya API quota used)
- the **battery camera** (a photo of the tank's display every few minutes)
- **router health** for the Router tab

It only makes outbound requests. Nothing is opened to the internet.

## 0. On the PC, once (already done)
```
npm run local-keys        # writes agent/devices.json (the plugs' local keys: a secret, keep it private)
cd agent && npm install
```
`agent/.env` already has the Worker address and key. The ready-to-copy package is `process/dist/tenergy-agent.zip`
(re-make it after changing anything in `agent/`: zip the agent folder without `node_modules`).

## 1. Prepare the phone
1. Install **F-Droid** (f-droid.org), then from F-Droid install **Termux**, **Termux:API** and **Termux:Boot**. (The Play Store versions are outdated.)
2. Android Settings, Apps: for all three, set Battery to **Unrestricted**. For Termux:API allow **Camera**.
3. Keep the phone on the same Wi-Fi as the plugs (not a guest network).

## 2. Put the agent on the phone
On the PC, zip the `agent` folder **without** `node_modules`, and send the zip to the phone privately (USB cable or a private chat). It contains secrets, so delete it afterwards.

In Termux:
```
pkg update && pkg install nodejs unzip termux-api
termux-setup-storage
cd ~ && unzip /sdcard/Download/agent.zip -d agent
cd agent && npm install
```

## Troubleshooting: Node will not start
If you see `CANNOT LINK EXECUTABLE "node": cannot locate symbol "OSSL_PROVIDER_add_conf_parameter"`, Termux's packages are out of step. Run
`pkg upgrade -y`, then `pkg install -y nodejs-lts`, then `node --version`. If it still fails, run `termux-change-repo` and pick another mirror first.

## 3. Try it, before mounting anything
Camera (does it see the screen clearly, day and night?):
```
node agent.js --test-camera        # saves last-photo.jpg
termux-open last-photo.jpg
```
Plugs over Wi-Fi (read-only):
```
node local-test.js                 # should print each plug's IP, protocol and data points
```
The agent finds plugs by scanning your Wi-Fi for devices on Tuya's local port and trying each plug's key (newer protocol 3.5 plugs, like your fridge plug, ignore the old broadcast search). If it says "not found on the local network", the plug is switched off or on a different Wi-Fi from the phone. If it says it can't tell which network to scan, add `LOCAL_SUBNET=192.168.18` (your network's first three numbers) to `.env`. Tested on your fridge plug: protocol 3.5, reads watts, volts, amps and the energy counter correctly.

## 3b. Light and focus for the battery photo
Termux's camera command takes the picture instantly: no focus time and no flash setting. Android's torch (flashlight) is a separate
command, so the agent can do "light on, wait, shoot, light off" itself. Put these in `agent/.env` on the phone, then re-run
`node agent.js --test-camera` and look at `last-photo.jpg`.

**Option A: phone torch + Termux camera (try this first)**
```
CAMERA_CMD=termux-camera-photo -c 0 {file}
CAMERA_BEFORE=termux-torch on
CAMERA_WAIT_SEC=2
CAMERA_WARMUP=1
CAMERA_VOTES=3
CAMERA_AFTER=termux-torch off
```
Camera `0` is the back camera (the one with the flash); `1` is the selfie camera. `CAMERA_WARMUP=1` takes one throwaway shot first, because the first picture is often soft or dark while focus and exposure settle. `CAMERA_VOTES=3` then takes three real photos a second apart. The Worker reads all three and accepts a percentage only when at least two agree; if they all differ it keeps the previous reading.
Some phones switch the torch off the moment the camera opens. If the photo comes out dark, that's what happened: use B, C or D.

**Option B: the free "IP Webcam" app**
It can focus first and switch its own light on. `pkg install curl`, start the server in the app, then:
```
CAMERA_CMD=curl -s -o {file} http://localhost:8080/photoaf.jpg
CAMERA_BEFORE=curl -s http://localhost:8080/enabletorch
CAMERA_WAIT_SEC=2
CAMERA_AFTER=curl -s http://localhost:8080/disabletorch
```
(Those are the app's address names as far as I know; its built-in help page lists them.) The catch: the app keeps the camera running while
its server is on, which uses a lot more battery than photos on demand.

**Option C: an automation app does the photo (Tasker, MacroDroid)**
Those apps have a "Take photo" action with flash, focus and delay settings, which is exactly "camera up, 2 seconds to focus, flash on".
Have it send the JPEG to the Worker with an HTTP action:
- POST to `https://home-energy-api.adeleke-tolu.workers.dev/api/battery/photo`
- headers `x-ingest-key: <the INGEST_KEY from agent/.env>` and `content-type: image/jpeg` (add `x-force: 1` to always read it)
- body: the photo file

Set `CAMERA_CMD=off` in `agent/.env` so the agent doesn't also take photos. The "Take photo now" button then won't trigger it
(the automation app only runs on its own timer).

**Option D: a separate light (often the most reliable)**
A small USB or battery LED light next to the tank, aimed at the screen from the side, lights it evenly with no flash glare, day or night.
Combine it with `CAMERA_SHOTS=2` and `CAMERA_WAIT_SEC=2`.

Then run it:
```
termux-wake-lock
node --env-file=.env agent.js
```
Tenergy's Settings, "Home agent and camera" shows LIVE, the photo interval, and the recent photos.

## 4. Start by itself after a reboot
```
mkdir -p ~/.termux/boot
printf '#!/data/data/com.termux/files/usr/bin/sh\ntermux-wake-lock\ncd ~/agent && node --env-file=.env agent.js >> agent.log 2>&1\n' > ~/.termux/boot/tenergy.sh
chmod +x ~/.termux/boot/tenergy.sh
```
Open the Termux:Boot app once so Android lets it run at startup.

## 5. Reading the percentage (optional, costs a little)
Photos are always stored. To have them read automatically, create an API key at console.anthropic.com, then on the PC:
```
cd worker
npx wrangler secret put ANTHROPIC_API_KEY
```
Paste the key when asked. Each new photo is read by a small vision model (about a fifth of a cent), limited to one automatic reading every 4 minutes and 300 a day. An unchanged picture is never uploaded.

## Notes
- **Power:** the phone needs a charger permanently. Keep it cool and ventilated; if the battery ever swells, stop using it. Many phones can cap charging at about 85% in their battery settings.
- **Photo settings** (interval, "take photo now") are in Tenergy's Settings, not on the phone.
- **Another camera:** set `CAMERA_CMD` in `.env`. `{file}` is where the picture is written.
- **If the phone loses internet,** the Worker falls back to Tuya's cloud on its own within about two minutes.
