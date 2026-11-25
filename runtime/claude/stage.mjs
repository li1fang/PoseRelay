import {Softbody, presets, levels, sides} from "./softbody-v1.mjs";
import {attach} from "./canvas-v1.mjs";

const width = 512;
const instanceId = "claude-local";
const page = document.querySelector("#figure");
const ctx = page.getContext("2d", {willReadFrequently: true});
const status = document.querySelector("#status");
const inputs = [...document.querySelectorAll("button, input, select")];
const manifestURL = new URL("./manifest.json", import.meta.url);
const clock = performance.now();
const now = () => Math.floor(performance.now() - clock);
const capabilities = {
  state: "ready", breathLevels: levels, impact: Object.fromEntries(levels.map(level => [level, sides])),
};
const curves = {...presets(1), periodMs: 3900, inhaleFraction: .46};
const soft = new Softbody(instanceId, capabilities, curves);
const fadeLength = 4/24;
const images = {}, clips = {}, events = [];
let pose = "D", motion = null, arrival = 0, spoken = null, eventNumber = 0;
let durationMs = 260, intervalMs = 4100, nextAuto = 2150, lastBlink = -Infinity;
let voiceBuffers = null, audioContext = null, activeControls = null;

async function bytes(root, file, wanted) {
  const response = await fetch(new URL(file, root));
  if (!response.ok) throw new Error(file+" HTTP "+response.status);
  const raw = await response.arrayBuffer();
  const hash = await crypto.subtle.digest("SHA-256", raw);
  const actual = Array.from(new Uint8Array(hash), n => n.toString(16).padStart(2, "0")).join("");
  if (actual !== wanted) throw new Error(file+" fingerprint mismatch");
  return raw;
}

async function bitmap(root, {file, sha256}) {
  return createImageBitmap(new Blob([await bytes(root, file, sha256)], {type:"image/png"}));
}

function canvas(size) {
  return Object.assign(document.createElement("canvas"), {width:size,height:size});
}

function layer(context, atlas, index) {
  const [x,y,w,h] = atlas.rect;
  context.drawImage(atlas.image,w*index,0,w,h,x,y,w,h);
}

async function loadPose(name, settings) {
  const root = new URL(name + "/", manifestURL);
  const size = settings.softbody.size[0];
  const body = canvas(size);
  const full = canvas(size);
  const layers = [settings.mouth, settings.eyes, settings.fringe];
  const [base, paintBody, ...atlases] = await Promise.all([
    bitmap(root, {file: settings.base, sha256: settings.baseSha256}),
    attach(body,settings.softbody,manifestURL),
    ...layers.map(item => bitmap(root,item)),
  ]);
  const [mouth, eyes, fringe] = layers.map((item,i) => ({...item,image:atlases[i]}));
  return {base, body, full, scene:full.getContext("2d"), paintBody, mouth, eyes, fringe};
}

async function loadVideo(clip) {
  const raw = await bytes(manifestURL,clip.file,clip.sha256);
  const element = document.createElement("video");
  element.muted = true;
  element.playsInline = true;
  element.preload = "auto";
  const ready = new Promise((resolve,reject) => {
    const abort = new AbortController();
    const timer = setTimeout(() => finish(new Error(clip.file+" decode timed out")),8000);
    function finish(error) {
      abort.abort();
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    }
    const params = {once:true,signal:abort.signal};
    element.addEventListener("loadeddata",()=>finish(),params);
    element.addEventListener("error",()=>finish(new Error(clip.file+" decode failed")),params);
  });
  element.src = URL.createObjectURL(new Blob([raw],{type:"video/mp4"}));
  await ready;
  return {...clip,element};
}

function log(phase, extra={}) {
  events.push({phase,pose,atMs:now(),...extra});
  status.value = {idle:"姿态 "+pose,transition:"转场 "+extra.from+" → "+extra.to,
                  speak:"姿态 "+pose+" · 说话",cancel:"已回到姿态 "+pose,
                  failure:"转场失败，已回到 "+pose}[phase];
}

function mouthAt() {
  if (!spoken?.analyser) return 0;
  spoken.analyser.getFloatTimeDomainData(spoken.samples);
  const rms = Math.sqrt(spoken.samples.reduce((sum,x) => sum + x*x,0)/spoken.samples.length);
  return Math.max(0,Math.min(1,(rms-.012)/.13));
}

function blinkAt(t) {
  if (t >= nextAuto) {
    lastBlink = t;
    nextAuto = t + intervalMs;
  }
  const elapsed = t - lastBlink;
  return elapsed >= 0 && elapsed < durationMs ? elapsed/durationMs : null;
}

function paintPose(target, name, controls) {
  const {body, full, scene, paintBody, mouth, eyes, fringe} = images[name];
  paintBody(controls.body);
  scene.drawImage(body,0,0);
  const mouthIndex = Math.round(controls.mouth*(mouth.frames-1));
  const eyeIndex = controls.blink === null ? 0 : Math.min(eyes.frames-1,Math.floor(controls.blink*eyes.frames));
  const fringeIndex = Math.round((controls.fringe+1)*.5*(fringe.frames-1));
  layer(scene,mouth,mouthIndex);
  layer(scene,eyes,eyeIndex);
  layer(scene,fringe,fringeIndex);
  target.drawImage(full,0,0,target.canvas.width,target.canvas.height);
  return {mouthIndex,eyeIndex,fringeIndex};
}

function update() {
  if (!motion) {
    const t = now();
    const ramp = Math.min(1, (t-arrival)/370);
    const current = soft.tick(t);
    const body = {left:ramp*current.left, right:ramp*current.right};
    activeControls = {...current, ...paintPose(ctx,pose,
      {body,mouth:mouthAt(),blink:blinkAt(t),fringe:ramp*Math.sin(t/770)})};
  }
  requestAnimationFrame(update);
}

function refresh() {
  for (const input of inputs) {
    input.disabled = input.id === "cancel" ? !motion : Boolean(motion || spoken);
  }
}

function softEvent(type, intensity, side) {
  const packet = {version:1,instanceId,eventId:"local-"+(++eventNumber),atMs:now(),type,intensity};
  if (side) packet.side = side;
  return soft.receive(packet);
}

function tuneBlink(update) {
  const speed = update.durationMs ?? durationMs;
  const interval = update.intervalMs ?? intervalMs;
  if (!Number.isSafeInteger(speed) || !Number.isSafeInteger(interval) ||
      speed<100 || speed>700 || interval<500 || interval>12000) throw new RangeError("Blink timing is out of range");
  durationMs = speed;
  if (interval !== intervalMs) nextAuto = now() + interval;
  intervalMs = interval;
  return {durationMs,intervalMs};
}

async function initAudio() {
  audioContext ??= new AudioContext();
  await audioContext.resume();
  voiceBuffers ??= Promise.all(Object.values(manifest.voices).map(async ({file,sha256}) =>
    audioContext.decodeAudioData(await bytes(manifestURL,file,sha256))));
  await voiceBuffers;
  return audioContext;
}

async function say(index=0) {
  if (motion) {
    if (await motion.done !== "complete") return "cancelled";
  }
  if (spoken) return "busy";
  const job = {};
  spoken = job;
  refresh();
  try {
    const audio = await initAudio();
    const buffer = (await voiceBuffers)[index];
    if (!buffer) throw new RangeError("Unknown voice line");
    const source = audio.createBufferSource();
    const analyser = audio.createAnalyser();
    analyser.fftSize = 512;
    source.buffer = buffer;
    source.connect(analyser);
    analyser.connect(audio.destination);
    if (window.canteen.captureAudio) analyser.connect(window.canteen.captureAudio);
    Object.assign(job,{analyser,samples:new Float32Array(analyser.fftSize)});
    log("speak",{line:index});
    const ended = new Promise(resolve => source.addEventListener("ended",resolve,{once:true}));
    source.start();
    await ended;
    source.disconnect();
    analyser.disconnect();
    return "complete";
  } finally {
    spoken = null;
    log("idle");
    refresh();
  }
}

function renderClip(job, mediaTime) {
  const {clip,snapshot} = job;
  const video = clip.element;
  ctx.drawImage(video,0,0,width,width);
  const remaining = video.duration - mediaTime - 1/clip.fps;
  if (mediaTime < fadeLength || remaining < fadeLength) {
    const starting = mediaTime < fadeLength;
    ctx.globalAlpha = 1 - Math.max(0, starting ? mediaTime : remaining)/fadeLength;
    ctx.drawImage(starting ? snapshot : images[clip.to].base,0,0,width,width);
    ctx.globalAlpha = 1;
  }
  job.frameCount++;
}

function travel(to) {
  if (motion || spoken) return Promise.resolve("busy");
  if (to === pose) return Promise.resolve("idle");
  const clip = clips[pose+to];
  if (!clip || clip.disabled) {
    log("failure",{to,reason:"missing_clip"});
    return Promise.resolve("failure");
  }
  const snapshot = canvas(width);
  snapshot.getContext("2d").drawImage(page,0,0);
  const video = clip.element;
  const handlers = new AbortController();
  const job = {clip,snapshot,frameCount:0};
  job.done = new Promise(resolve => {
    let scheduled, watchdog;
    function finish(result) {
      if (motion !== job) return;
      handlers.abort();
      clearTimeout(watchdog);
      video.cancelVideoFrameCallback(scheduled);
      video.pause();
      if (result === "complete") {
        pose = clip.to;
        arrival = now();
        soft.swap(capabilities,curves,arrival);
        ctx.drawImage(images[pose].base,0,0,width,width);
        activeControls = {...soft.sample(arrival), mouthIndex:0, eyeIndex:0,
                          fringeIndex:images[pose].fringe.idleIndex};
      } else {
        ctx.drawImage(snapshot,0,0);
      }
      motion = null;
      log(result === "complete" ? "idle" : result,
          {from:clip.from,to:clip.to,frameCount:job.frameCount});
      refresh();
      resolve(result);
    }
    const frame = (_, metadata) => {
      renderClip(job,metadata.mediaTime);
      scheduled = video.requestVideoFrameCallback(frame);
    };
    job.cancel = () => finish("cancel");
    motion = job;
    log("transition",{from:clip.from,to:clip.to});
    refresh();
    const options = {signal:handlers.signal,once:true};
    video.currentTime = 0;
    video.addEventListener("ended",() => finish("complete"),options);
    video.addEventListener("error",() => finish("failure"),options);
    watchdog = setTimeout(() => finish("failure"),Math.ceil(video.duration*1000)+1900);
    scheduled = video.requestVideoFrameCallback(frame);
    video.play().catch(() => finish("failure"));
  });
  return job.done;
}

const manifestResponse = await fetch(manifestURL);
if (!manifestResponse.ok) throw new Error("Portrait manifest missing");
const manifest = await manifestResponse.json();
try {
  await Promise.all([
    ...Object.entries(manifest.poses).map(async ([name,view]) => { images[name] = await loadPose(name,view); }),
    ...Object.entries(manifest.clips).map(async ([name,clip]) => {
      if (!manifest.poses[clip.from] || !manifest.poses[clip.to] ||
          clip.endpoints[0] !== manifest.poses[clip.from].baseSha256 ||
          clip.endpoints[1] !== manifest.poses[clip.to].baseSha256) throw new Error("Invalid endpoints "+name);
      try { clips[name] = await loadVideo(clip); }
      catch { clips[name] = {...clip,disabled:true}; }
    }),
  ]);
  const blinkOnce = () => { lastBlink = now(); nextAuto = lastBlink+intervalMs; };
  const hit = (intensity,side="both") => softEvent("softbody.impact",intensity,side);
  const breath = intensity => softEvent("softbody.breath",intensity);
  window.canteen = {
    travel,say,blinkOnce,tuneBlink,hit,breath,initAudio,time:now,
    cancel: () => motion?.cancel(),
    snapshot: () => ({...activeControls,breathPhase:activeControls?.phase,
                       pose,phase:motion?"transition":spoken?"speak":"idle"}),
    events,
    previewFrame(name, controls) {
      const probe = canvas(controls.native ? images[name].full.width : width);
      paintPose(probe.getContext("2d"),name,controls);
      return probe.toDataURL();
    },
  };
  for (const button of document.querySelectorAll("[data-pose]"))
    button.addEventListener("click",() => travel(button.dataset.pose));
  document.querySelector("#cancel").onclick = window.canteen.cancel;
  document.querySelector("#voice").onclick = () => say(0);
  document.querySelector("#blink").onclick = blinkOnce;
  document.querySelector("#breath").onchange = event => breath(event.target.value);
  document.querySelector("#hit").onclick = () => hit(document.querySelector("#impact").value);
  document.querySelector("#duration").onchange = event => tuneBlink({durationMs:Number(event.target.value)});
  document.querySelector("#interval").onchange = event => tuneBlink({intervalMs:Number(event.target.value)});
  arrival = now();
  log("idle");
  refresh();
  update();
} catch (error) {
  status.value = "载入失败";
  console.error(error);
}
