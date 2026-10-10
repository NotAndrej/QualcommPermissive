import { FastbootDevice, Adb, AdbDaemonTransport, AdbDaemonWebUsbDeviceManager, AdbWebCredentialStore } from "./app.bundle.js";
/* page logic */

/* ---------- clocks ---------- */
function tickClock() {
  const n = new Date();
  const hh = String(n.getHours()).padStart(2, "0");
  const mm = String(n.getMinutes()).padStart(2, "0");
  document.getElementById("hh").textContent = hh;
  document.getElementById("mm").textContent = mm;
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const dateLine = `${days[n.getDay()]}, ${months[n.getMonth()]} ${n.getDate()}`;
  document.getElementById("dateline").textContent = dateLine;
  document.getElementById("w1").textContent = dateLine;
  document.querySelectorAll(".sb-time").forEach((el) => { el.textContent = `${hh}:${mm}`; });
}
tickClock();
setInterval(tickClock, 10000);

/* ---------- log ---------- */
const outEl = document.getElementById("applog");
function log(msg, cls = "") {
  const div = document.createElement("div");
  if (cls) div.className = cls;
  const t = new Date();
  const stamp = [t.getHours(), t.getMinutes(), t.getSeconds()]
    .map((n) => String(n).padStart(2, "0")).join(":");
  div.textContent = `[${stamp}] ${msg}`;
  outEl.appendChild(div);
  outEl.scrollTop = outEl.scrollHeight;
}

function friendlyError(e) {
  const msg = e && e.message ? e.message : String(e);
  if (/in use|used by another|already.*open|access denied/i.test(msg)) {
    log("    > kill the desktop ADB server: adb kill-server", "hint");
  }
  if (/timed out|timeout/i.test(msg)) {
    log("    > no approval. screen ON+unlocked, File transfer mode,", "hint");
    log("    > toggle USB debugging, revoke authorizations, replug.", "hint");
  }
  return msg;
}

function setDot(n, on) {
  document.getElementById("d" + n).className = on ? "on" : "off";
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- USB re-enumeration watch: bootloader = drop + reappear ---------- */
let usbSawDisconnect = false;
let usbSawConnectAfterDrop = false;
let usbChurnCount = 0;
if (navigator.usb) {
  navigator.usb.addEventListener("disconnect", () => { usbSawDisconnect = true; usbChurnCount++; });
  navigator.usb.addEventListener("connect", () => { if (usbSawDisconnect) usbSawConnectAfterDrop = true; usbChurnCount++; });
}
function usbChurnReset() { usbSawDisconnect = false; usbSawConnectAfterDrop = false; }
let churnWatchActive = false;
async function waitUsbChurn(timeoutMs) {
  const start = Date.now();
  let saidLeft = false, saidBack = false, lastBeat = 0;
  while (Date.now() - start < timeoutMs && churnWatchActive) {
    const elapsed = Math.floor((Date.now() - start) / 1000);
    if (usbSawDisconnect && !saidLeft) {
      saidLeft = true;
      log(`Device left USB (${elapsed}s). Waiting for it to come back...`);
    }
    if (usbSawDisconnect && usbSawConnectAfterDrop && !saidBack) {
      saidBack = true;
      log(`Something reappeared on USB (${elapsed}s). Checking...`);
    }
    if (usbSawDisconnect && usbSawConnectAfterDrop) return true;
    if (elapsed - lastBeat >= 10) {
      lastBeat = elapsed;
      log(`Still watching USB (${elapsed}s)...`, "dim");
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return usbSawDisconnect && usbSawConnectAfterDrop;
}

/* ---------- pill gate: swipe up from the bottom pill, or tap it ---------- */
const pillbar = document.getElementById("pillbar");
const pilllabel = document.getElementById("pilllabel");
let pillResolve = null;
let pillStartY = null;

function pillGate(label, focus) {
  pilllabel.textContent = label;
  pillbar.classList.add("armed", "ready");
  if (focus) pillbar.classList.add("focus");
  pillbar.setAttribute("role", "button");
  pillbar.setAttribute("tabindex", "0");
  pillbar.setAttribute("aria-label", label + ". Press Enter to continue.");
  return new Promise((resolve) => { pillResolve = resolve; });
}
function pillDisarm() {
  pilllabel.textContent = "";
  pillbar.classList.remove("armed", "focus", "ready");
  pillbar.removeAttribute("role");
  pillbar.removeAttribute("tabindex");
  pillbar.removeAttribute("aria-label");
  pillResolve = null;
}
const pullcircle = document.getElementById("pullcircle");
let pillLastY = 0, pillLastT = 0;
function pillSnapBack() {
  pullcircle.style.transition = "transform 0.35s cubic-bezier(0.2, 0.9, 0.3, 1.4)";
  pullcircle.style.transform = "";
  setTimeout(() => { pullcircle.style.transition = ""; }, 380);
}
pillbar.addEventListener("pointerdown", (e) => {
  pillStartY = e.clientY; pillLastY = e.clientY; pillLastT = performance.now();
  pullcircle.style.transition = "none";
});
pillbar.addEventListener("pointermove", (e) => {
  if (pillStartY === null || !pillResolve) return;
  const dy = pillStartY - e.clientY;
  if (dy > 0) pullcircle.style.transform = `translateY(${-Math.min(dy, 160)}px)`;
  pillLastY = e.clientY; pillLastT = performance.now();
  if (dy > 50) {
    const r = pillResolve;
    pillDisarm();
    pillStartY = null;
    pullcircle.style.transition = "";
    pullcircle.style.transform = "";
    r();
  }
});
pillbar.addEventListener("pointerup", () => {
  // swipe-only: taps deliberately do nothing here.
  pillStartY = null;
  if (pillResolve) pillSnapBack();
});
pillbar.addEventListener("pointercancel", () => { pillStartY = null; if (pillResolve) pillSnapBack(); });
pillbar.addEventListener("keydown", (e) => {
  if (!pillResolve) return;
  if (e.key === "Enter" || e.key === " " || e.key === "ArrowUp") {
    e.preventDefault();
    const r = pillResolve;
    pillDisarm();
    r();
  }
});

/* ---------- adb / fastboot core ---------- */
const OEM_COMMAND = "oem set-gpu-preemption 0 androidboot.selinux=permissive";
const AUTH_TIMEOUT_MS = 90000;

function withTimeout(promise, ms, what) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(what + " timed out")), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function adbManager() {
  const Manager = AdbDaemonWebUsbDeviceManager.BROWSER;
  if (!Manager) throw new Error("WebUSB not available in this browser");
  return Manager;
}

let pickedSerial = ""; // phase-1 device, reused for verification

async function pickAdbDevice() {
  // Always the picker, never a guess: ADB and fastboot names/serials are
  // not guaranteed to match across OEMs (or across reboots).
  const Manager = adbManager();
  log("Select your device in the browser window...");
  const device = await Manager.requestDevice();
  if (!device) throw new Error("no device selected");
  pickedSerial = device.serial || "";
  return device;
}

async function adbTransportFrom(device, quiet) {
  if (!quiet) log("Connecting (approve USB debugging if asked)...");
  const connection = await device.connect();
  const credentialStore = new AdbWebCredentialStore("permissive-boot");
  const transport = await withTimeout(
    AdbDaemonTransport.authenticate({ serial: device.serial, connection, credentialStore }),
    AUTH_TIMEOUT_MS,
    "authentication"
  );
  if (!quiet) log("Connected.");
  return transport;
}

async function adbShellOneShot(command) {
  const transport = await adbTransportFrom(await pickAdbDevice());
  try {
    const adb = new Adb(transport);
    const proc = await adb.subprocess.noneProtocol.spawn(command);
    let output = "";
    try {
      for await (const chunk of proc.output.pipeThrough(new TextDecoderStream())) {
        output += chunk;
      }
    } catch (e) { /* reboot drops the connection */ }
    let code = null;
    try { code = await proc.exit; } catch (e) { /* reboot kills the stream */ }
    return { output: output.trim(), code };
  } finally {
    try { transport.close(); } catch (e) { /* already gone */ }
  }
}

let running = false;

async function doPhase1() {
  setDot(1, true);
  await adbShellOneShot("reboot bootloader");
  log("[+] Rebooting to bootloader.", "ok");
}

async function doPhase2() {
  setDot(2, true);
  const device = new FastbootDevice();
  try {
    // The bootloader interface is often briefly held by something else
    // (e.g. modem probing) right after enumeration. Retry the claim
    // instead of failing the whole run on one busy moment.
    let connected = false;
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        await device.connect();
        connected = true;
        break;
      } catch (e) {
        const msg = e && e.message ? e.message : String(e);
        if (e instanceof DOMException && e.name === "NotFoundError") throw e;
        if (attempt === 4) throw e;
        log(`Interface busy, retrying (${attempt}/4)...`, "dim");
        await sleep(2500);
      }
    }
    if (!connected) throw new Error("could not claim the fastboot interface");
    let product = "", serial = "";
    try {
      product = await device.getVariable("product");
      serial = await device.getVariable("serialno");
    } catch (e) { /* hidden vars are not fatal */ }
    log("Bootloader connected.");

    log("Sending permissive command...");
    const result = await device.runCommand(OEM_COMMAND);
    log("[+] Bootloader accepted the command.", "ok");

    log("Restarting into the system...");
    try {
      await device.runCommand("continue");
    } catch (e) {
      log("'continue' failed (" + e.message + "), trying 'reboot'...");
      await device.runCommand("reboot");
    }
    log("[+] Device is restarting.", "ok");
  } finally {
    try { await device.disconnect(); } catch (e) { /* link already down */ }
  }
}

async function waitForAdbAndVerify() {
  setDot(3, true);
  log("Waiting for the system to come back...");
  const Manager = adbManager();
  const deadline = Date.now() + 6 * 60 * 1000;
  // No blind wait: presence-poll immediately. A too-early attempt fails
  // fast and quiet; the pill lets the user swipe the moment THEY see the
  // system is back, which beats any fixed floor.
  let lastGateChurn = -1;
  while (Date.now() < deadline) {
    // Same device phase 1 picked (matched by serial — a rebooted USB
    // device needs a fresh handle). No picks, no prompts here.
    let dev = null;
    try {
      const granted = await Manager.getDevices();
      dev = granted.find((d) => d.serial && d.serial === pickedSerial)
        || granted.find((d) => !pickedSerial && d.serial)
        || null;
    } catch (e) { /* retry quietly */ }
    if (!dev) { await sleep(2000); continue; }
    let transport = null;
    try {
      // 15s cap: a healthy adbd handshakes in ~1-3s. A wedged one must fail
      // fast so the loop retries instead of sitting out 45s.
      transport = await withTimeout(adbTransportFrom(dev, true), 15000, "ADB connect");
      const adb = new Adb(transport);
      let deadStreak = 0;
      while (Date.now() < deadline) {
        try {
          const proc = await adb.subprocess.noneProtocol.spawn("getenforce");
          let output = "";
          for await (const chunk of proc.output.pipeThrough(new TextDecoderStream())) {
            output += chunk;
          }
          output = output.trim();
          if (!output) throw new Error("empty reply");
          if (/permissive/i.test(output)) {
            log("[+] SELinux is " + output + ". Done.", "ok");
            return true;
          }
          log("[!] Still enforcing. The command did not take.", "err");
          return false;
        } catch (e) {
          // Quiet: system still booting or stream torn down mid-boot.
          if (++deadStreak >= 10) break;
          await sleep(1000);
        }
      }
    } catch (e) { await sleep(3000); continue; } finally {
      try { if (transport) transport.close(); } catch (e2) { /* already gone */ }
    }
  }
  log("[!] The system never came back. Replug the cable and swipe the pill.", "err");
  return false;
}

let resumePhase = 1; // retry resumes here, not at phase 1

async function runAll() {
  if (running) return;
  running = true;
  let rearmed = false;
  document.getElementById("busybar").hidden = false;
  try {
    if (resumePhase <= 1) {
      usbChurnReset();
      await doPhase1();
      await sleep(3000);
      // Watch in the background only; the single swipe below is the gate.
      churnWatchActive = true;
      waitUsbChurn(90000).then((ok) => {
        if (ok && churnWatchActive) log("[+] Bootloader is ready.", "ok");
      });
      resumePhase = 2;
    }
    if (resumePhase <= 2) {
      await pillGate("swipe to pick the bootloader device", true);
      churnWatchActive = false;
      await doPhase2();
      resumePhase = 3;
    }
    await waitForAdbAndVerify();
    resumePhase = 1;
    log("Swipe the pill to run again.", "dim");
    rearmed = true;
    pillGate("swipe the pill to run again", false).then(() => {
      if (!running) runAll();
    });
  } catch (e) {
    const msg = friendlyError(e);
    log("Stopped: " + msg, "err");
    if (/no device selected/i.test(msg)) {
      log("If the list was empty: check the cable, USB debugging on,", "hint");
      log("File transfer mode, and only one browser tab on USB.", "hint");
    }
  } finally {
    running = false;
    document.getElementById("busybar").hidden = true;
    if (!rearmed) {
      rearmed = true;
      const retryLabel = resumePhase >= 3 ? "swipe the pill to retry verify"
        : resumePhase === 2 ? "swipe the pill to retry fastboot" : "swipe the pill to retry";
      pillGate(retryLabel, false).then(() => {
        if (!running) runAll();
      });
    }
  }
}

/* ---------- lock screen swipe ---------- */
const lockEl = document.getElementById("lock");
const appEl = document.getElementById("app");
let dragStartY = null;

const clockEl = document.getElementById("clock");
const lockBottomEl = document.getElementById("lockbottom");
function clearLockFx() {
  lockEl.style.transition = "";
  lockEl.style.transform = "";
  lockEl.style.opacity = "";
  clockEl.style.transform = "";
  clockEl.style.opacity = "";
  lockBottomEl.style.opacity = "";
}
function stageAppBehind(progress) {
  // AOSP swipe-to-unlock: the behind-surface tracks the finger and can be
  // paused or reversed. progress 0..1 maps scale .92->1, lift 60px->0.
  appEl.classList.remove("hidden");
  appEl.classList.add("peek");
  const p = Math.max(0, Math.min(1, progress));
  appEl.style.transition = "none";
  appEl.style.transform = `scale(${0.92 + 0.08 * p}) translateY(${(1 - p) * 60}px)`;
  appEl.style.opacity = String(0.25 + 0.75 * p);
}
function openApp() {
  clearLockFx();
  appEl.classList.remove("hidden");
  appEl.classList.remove("peek");
  appEl.style.transition = "transform 0.24s cubic-bezier(0.4, 0, 1, 1), opacity 0.24s cubic-bezier(0.4, 0, 1, 1)";
  appEl.style.transform = "";
  appEl.style.opacity = "";
  lockEl.classList.add("unlocking");
  setTimeout(() => {
    lockEl.classList.add("hidden");
    appEl.style.transition = "";
  }, 260);
}

let lockLastY = 0, lockLastT = 0;
function lockSnapBack() {
  appEl.style.transition = "transform 0.3s ease-out, opacity 0.25s ease-out";
  appEl.style.transform = "";
  appEl.style.opacity = "";
  setTimeout(() => {
    if (!running) { appEl.classList.add("hidden"); appEl.classList.remove("peek"); }
    appEl.style.transition = "";
  }, 320);
  lockEl.style.transition = "transform 0.4s cubic-bezier(0.2, 0.9, 0.3, 1.3), opacity 0.3s ease-out";
  lockEl.style.transform = "";
  lockEl.style.opacity = "";
  clockEl.style.transform = "";
  clockEl.style.opacity = "";
  lockBottomEl.style.opacity = "";
  clockEl.style.transition = "transform 0.4s cubic-bezier(0.2, 0.9, 0.3, 1.3), opacity 0.3s ease-out";
  lockBottomEl.style.transition = "opacity 0.3s ease-out";
  setTimeout(() => { lockEl.style.transition = ""; clockEl.style.transition = ""; lockBottomEl.style.transition = ""; }, 450);
}
function lockFling() {
  lockEl.style.transition = "";
  lockEl.style.transform = "";
  lockEl.style.opacity = "";
  openApp();
  resumePhase = 1;
  runAll();
}
lockEl.addEventListener("pointerdown", (e) => {
  dragStartY = e.clientY; lockLastY = e.clientY; lockLastT = performance.now();
  lockEl.style.transition = "none";
});
lockEl.addEventListener("pointermove", (e) => {
  if (dragStartY === null || running) return;
  const dy = dragStartY - e.clientY;
  if (dy > 0) {
    const pull = Math.min(dy, window.innerHeight * 0.7);
    const prog = pull / window.innerHeight;
    lockEl.style.transform = `translateY(${-pull}px)`;
    lockEl.style.opacity = String(Math.max(0.3, 1 - prog * 1.1));
    clockEl.style.transform = `translateY(${-pull * 0.35}px)`;
    clockEl.style.opacity = String(Math.max(0, 1 - prog * 2.2));
    lockBottomEl.style.opacity = String(Math.max(0, 1 - prog * 2.6));
    stageAppBehind(prog * 1.6);
  }
  lockLastY = e.clientY; lockLastT = performance.now();
  if (dy > 90) {
    dragStartY = null;
    lockFling();
  }
});
lockEl.addEventListener("pointerup", (e) => {
  if (dragStartY === null) return;
  const dy = dragStartY - e.clientY;
  const dt = Math.max(1, performance.now() - lockLastT);
  const vel = (lockLastY - e.clientY) / dt;
  dragStartY = null;
  if (running) { lockSnapBack(); return; }
  if (dy > window.innerHeight * 0.25 || vel > 0.6) lockFling();
  else lockSnapBack();
});
lockEl.addEventListener("pointercancel", () => { dragStartY = null; if (!running) lockSnapBack(); });
lockEl.addEventListener("keydown", (e) => {
  if ((e.key === "Enter" || e.key === " ") && !running) {
    e.preventDefault();
    openApp();
    resumePhase = 1;
    runAll();
  }
});



