# QualcommPermissive

Browser-based helper that boots an **unpatched Qualcomm device** with SELinux in
permissive mode. It runs from one page over a USB cable, with no
platform-tools install, drivers, or command line.

> Works only on Qualcomm devices whose bootloader still accepts the OEM
> command used here. Patched bootloaders answer `OKAY` without effect or reject
> the command. Nothing on this page can bypass a patched bootloader, unlock
> anything, or flash anything.

## How it works

1. **Reboot to bootloader** over ADB (WebUSB).
2. **Send the OEM command** over fastboot, then resume the boot.
3. **Verify** over ADB that SELinux reports `Permissive`.

The page handles USB mode switches for you. Two picks total: one for the
ADB reboot, one for the fastboot command. Verification reuses the first
device, no third pick.

## Requirements

- Desktop Chrome or Edge (WebUSB support required).
- Page served over HTTPS or `http://localhost` (WebUSB secure-context rule).
- USB cable, USB debugging enabled on the device.
- An **unpatched** Qualcomm bootloader (see note above).

## Usage

Easiest: open the hosted copy at
https://notandrej.github.io/QualcommPermissive/. Nothing to install or serve.

To run it locally instead, serve the folder and open it:

```
python3 -m http.server 8000
# open http://localhost:8000
```

1. Kill anything else holding USB: `adb kill-server`. Only one program can
   hold the device at a time.
2. Swipe up on the lock screen, approve USB debugging on the device if asked.
3. Swipe the pill when it prompts (fastboot pick), then let verification run
   itself.

## Troubleshooting

- **Device in use / cannot claim interface** — desktop ADB server (or another
  tab) holds the device. `adb kill-server`, close other USB tabs, retry.
- **No approval popup** — screen on and unlocked, USB mode File transfer,
  toggle USB debugging off/on, revoke old authorizations, replug.
- **Picker is empty** — wrong mode for that step (ADB steps list ADB-mode
  devices; the fastboot step lists bootloader-mode ones), bad cable, or
  debugging disabled.
- **Still enforcing after the run** — the bootloader ignored the command;
  the device is patched for this trick. To confirm against the firmware
  itself, scan its ABL image with
  [`chkndrp/qualcomm-gbl-exploit-checker`](https://github.com/chkndrp/qualcomm-gbl-exploit-checker):
  validation logic present means patched.

## Files

- `index.html` — lock screen, app shell, and styles. Loads `app.js`.
  Running needs nothing installed: open the page over HTTP and it runs.
- `app.js` — flow logic (phases, USB watch, verify loop). Imports the
  WebUSB stacks from `app.bundle.mjs`.
- `app.bundle.mjs` — prebuilt ADB + fastboot stacks. Rebuild after any
  dependency change: `npm install && npm run build` (needs Node + esbuild;
  `src/main.js` is the entrypoint, names must stay unmangled).
- `icons/` — status-bar icon masters. `LICENSE` — AGPL-3.0 text.

## Disclaimer

For security research and educational use on devices you own or are authorized
to test. This tool reboots your device and sends a vendor-specific bootloader
command: it may break your device, wipe data, or void warranties. Use it
at your own risk; there is no warranty.

## License

QualcommPermissive itself is licensed under the **GNU Affero General Public
License v3.0 or later** — see [LICENSE](LICENSE). Serve it, fork it, or
modify it. If you run a modified version on a server, share the source under
the same terms.

Bundled third-party work keeps its own license (all compatible; the minified
bundle strips their notice comments, so they are credited here instead):
- `android-fastboot` (kdrag0n, fastboot.js) — MIT
- `@yume-chan/adb`, `@yume-chan/adb-daemon-webusb`, `@yume-chan/adb-credential-web` (Tango ADB) — MIT
- `@zip.js/zip.js` — BSD-3-Clause
- `pako` — MIT/Zlib
- Roboto and Material Symbols fonts (Google) — Apache License 2.0
- Status-bar icon artwork in `icons/` follows AOSP artwork (Google) — Apache License 2.0
