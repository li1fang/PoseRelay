// Shared project playback adapted from the Dragon continuous-mouth rehearsal.
const pid = new URL(location.href).searchParams.get("p");
const standalone = document.documentElement.hasAttribute("data-standalone");
const tr = (zh, en) => document.documentElement.lang === "en" ? en : zh;
const manifestURL = new URL(standalone ? tr("./manifest.json","./manifest-en.json") : "/studio/api/projects/"+pid+"/player",location.href);
const status = document.querySelector("#status");
const manifestResponse = await fetch(manifestURL);
if (!manifestResponse.ok) {
  status.value = "请返回转场，确认当前定帧后再实播";
  throw new Error("Project playback manifest unavailable");
}
const manifest = await manifestResponse.json();
document.querySelector("#player-title").textContent = manifest.title;
if (!standalone) document.querySelector("#back").href = "/studio/?p="+pid+"&step=transitions";
const [{Softbody,presets,levels,sides},{attach}] = await Promise.all([
  import(new URL(manifest.engine+"softbody-v1.mjs",manifestURL).href),
  import(new URL(manifest.engine+"canvas-v1.mjs",manifestURL).href),
]);
const route = (from,to) => from+"/"+to;
for (const [id, view] of Object.entries(manifest.poses)) {
  const button = document.createElement("button");
  button.dataset.pose = id;
  button.textContent = view.title;
  button.title = view.group+" · "+view.title;
  document.querySelector("#poses").append(button);
}
document.querySelector("#pending").textContent = manifest.pendingRoutes ? manifest.pendingRoutes+" 条路线待选片" : "";
const width = 512;
const instanceId = "project-player";
const page = document.querySelector("#figure");
const ctx = page.getContext("2d", {willReadFrequently: true});
const inputs = [...document.querySelectorAll("button, input, select")];
const clock = performance.now();
const now = () => Math.floor(performance.now() - clock);
const capabilities = {
  state: "ready", breathLevels: levels, impact: Object.fromEntries(levels.map(level => [level, sides])),
};
const hiddenRegion = {state:"region_not_visible"};
const curves = {...presets(1), periodMs: 3900, inhaleFraction: .46};
const soft = new Softbody(instanceId, capabilities, curves);
const fadeLength = 4/24;
const images = {}, clips = {}, events = [], mouthTracks = {};
const motionEndpoint=canvas(width).getContext("2d");
let pose = manifest.initialPose, motion = null, arrival = 0, spoken = null, eventNumber = 0;
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

function canvas(width, height=width) {
  return Object.assign(document.createElement("canvas"), {width,height});
}

function layer(context, atlas, index) {
  const [x,y,w,h] = atlas.rect;
  context.drawImage(atlas.image,w*index,0,w,h,x,y,w,h);
}

async function loadPose(settings) {
  const root = manifestURL;
  const base = await bitmap(root, {file: settings.base, sha256: settings.baseSha256});
  const body = settings.softbody && canvas(base.width,base.height);
  const full = canvas(base.width,base.height);
  const layers = [settings.mouth, settings.eyes, settings.fringe];
  const [paintBody, ...atlases] = await Promise.all([
    body && attach(body,settings.softbody,manifestURL),
    ...layers.map(item => item && bitmap(root,item)),
  ]);
  const [mouth, eyes, fringe] = layers.map((item,i) => item && ({...item,image:atlases[i]}));
  return {base, body, full, scene:full.getContext("2d"), paintBody, mouth, eyes, fringe};
}

async function loadVideo(clip) {
  const raw = await bytes(manifestURL,clip.file,clip.sha256);
  const element = document.createElement("video");
  element.playbackRate = clip.rate;
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
  const label = name => manifest.poses[name]?.title ?? name;
  if (motion) {
    const {source,to,rate} = motion.clip;
    status.value = label(source)+" → "+label(to)+" · "+rate+"×"+(spoken?.analyser ? tr(" · 说话"," \u00b7 Speaking") : "");
    return;
  }
  status.value = {idle:tr("姿态 ","Pose ")+label(pose)+(spoken?.analyser ? tr(" · 说话"," \u00b7 Speaking") : ""),
                  speak:tr("姿态 ","Pose ")+label(pose)+tr(" · 说话"," \u00b7 Speaking"),cancel:tr("已回到 ","Returned to ")+label(pose),
                  failure:tr("转场失败，已回到 ","Turn failed. Returned to ")+label(pose)}[phase];
}

function mouthAt() {
  if (!spoken?.analyser) return 0;
  spoken.analyser.getFloatTimeDomainData(spoken.samples);
  const rms = Math.sqrt(spoken.samples.reduce((sum,x) => sum + x*x,0)/spoken.samples.length);
  spoken.rms = rms;
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
  const {base, body, full, scene, paintBody, mouth, eyes, fringe} = images[name];
  if (paintBody) paintBody(controls.body);
  scene.drawImage(body || base,0,0);
  const mouthIndex = mouth ? Math.round(controls.mouth*(mouth.frames-1)) : 0;
  const eyeIndex = !eyes || controls.blink === null ? 0 : Math.min(eyes.frames-1,Math.floor(controls.blink*eyes.frames));
  const fringeIndex = fringe ? Math.round((controls.fringe+1)*.5*(fringe.frames-1)) : 0;
  if (mouth) layer(scene,mouth,mouthIndex);
  if (eyes) layer(scene,eyes,eyeIndex);
  if (fringe) layer(scene,fringe,fringeIndex);
  const scale = Math.min(target.canvas.width/full.width,target.canvas.height/full.height);
  const w = full.width*scale, h = full.height*scale;
  target.clearRect(0,0,target.canvas.width,target.canvas.height);
  target.drawImage(full,(target.canvas.width-w)/2,(target.canvas.height-h)/2,w,h);
  return {mouthIndex,eyeIndex,fringeIndex};
}

function update() {
  if (!motion) {
    const t = now();
    const ramp = Math.min(1, (t-arrival)/370);
    const current = soft.tick(t);
    const breathing = manifest.poses[pose].breath?.length;
    const body = {left:ramp*(breathing ? current.left : current.leftHit),
                  right:ramp*(breathing ? current.right : current.rightHit)};
    activeControls = {...current, ...paintPose(ctx,pose,
      {body,mouth:mouthAt(),blink:blinkAt(t),fringe:ramp*Math.sin(t/770)})};
  } else if (motion.mediaTime !== undefined) {
    renderClip(motion,motion.mediaTime);
  }
  requestAnimationFrame(update);
}

function refresh() {
  const view = manifest.poses[pose];
  for (const kind of ["breath","impact"]) {
    const values = view.softbody ? view[kind] : [];
    const select = document.querySelector("#"+kind);
    for (const option of select.options) option.disabled = !values.includes(option.value);
    if (!values.includes(select.value)) select.value = values[0] ?? "";
  }
  for (const input of inputs) {
    if (input.dataset.pose) {
      const key = route(pose,input.dataset.pose);
      input.disabled = Boolean(motion || !clips[key]?.element || (spoken && !mouthTracks[key]));
      continue;
    }
    input.disabled = Boolean(motion || spoken);
    if (input.id === "cancel") input.disabled = !motion;
    if (input.id === "voice") input.disabled = !images[pose].mouth || !manifest.voices.length ||
      Boolean(spoken || (motion && !hasTransitionMouth(motion.clip)));
    if (["blink","duration","interval"].includes(input.id) && !images[pose].eyes) input.disabled = true;
    if (input.id === "breath" && (!view.softbody || !view.breath.length)) input.disabled = true;
    if (["impact","hit","impact-side"].includes(input.id) && (!view.softbody || !view.impact.length)) input.disabled = true;
  }
  const speakingTargets = Object.values(clips).filter(clip =>
    clip.source === pose && clip.element && hasTransitionMouth(clip)).map(clip => manifest.poses[clip.to].title);
  document.querySelector("#speech-hint").textContent = speakingTargets.length && manifest.voices.length
    ? tr("试试先点「试听台词」，再转向","Play the sample line, then choose ")+speakingTargets.join(tr("、",", "))+tr("。",".") : "";
}

function softEvent(type, intensity, side) {
  const packet = {version:1,instanceId,eventId:"local-"+(++eventNumber),atMs:now(),type,intensity};
  if (side) packet.side = side;
  return soft.receive(packet);
}

function enterPose() {
  const view = manifest.poses[pose];
  soft.swap(images[pose].paintBody ? capabilities : hiddenRegion,curves,arrival);
  if (view.softbody && view.breath.length && !view.breath.includes(soft.sample(arrival).level)) {
    softEvent("softbody.breath",view.breath[0]);
  }
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
  voiceBuffers ??= Promise.all(manifest.voices.map(async ({file,sha256}) =>
    audioContext.decodeAudioData(await bytes(manifestURL,file,sha256))));
  await voiceBuffers;
  return audioContext;
}

function hasTransitionMouth(clip) {
  return Boolean(mouthTracks[route(clip.source,clip.to)]);
}

async function say(index=0) {
  const transition = motion;
  if (transition && !hasTransitionMouth(transition.clip) && await transition.done !== "complete") return "cancelled";
  if (spoken) return "busy";
  if (!images[pose].mouth) return "unsupported";
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
    if (window.projectPlayer.captureAudio) analyser.connect(window.projectPlayer.captureAudio);
    const startedAt = audio.currentTime;
    Object.assign(job,{analyser,samples:new Float32Array(analyser.fftSize),startedAt});
    log("speak",{line:index,duration:buffer.duration,audioRate:source.playbackRate.value,audioTime:startedAt});
    const ended = new Promise(resolve => source.addEventListener("ended",resolve,{once:true}));
    source.start(startedAt);
    await ended;
    events.push({phase:"voiceEnd",atMs:now(),audioTime:audio.currentTime});
    source.disconnect();
    analyser.disconnect();
    return "complete";
  } finally {
    spoken = null;
    log("idle");
    refresh();
  }
}

function setupConfirmation() {
  if (standalone) return;
  const form = document.querySelector("#performance-review");
  const report = document.querySelector("#performance-status");
  function showDownload(record) {
    form.hidden = true;
    document.querySelector("#performance-download").hidden = false;
    document.querySelector("#release-note").textContent = record.note;
    document.querySelector("#download-package").href = record.download;
  }
  if (manifest.review.approved) {showDownload(manifest.review.approved); return;}
  if (!Object.keys(clips).length || manifest.pendingRoutes || Object.values(clips).some(clip=>clip.disabled)) return;
  form.hidden = false;
  form.onsubmit = async event => {
    event.preventDefault();
    const button = form.querySelector("button");
    button.disabled = true;
    report.textContent = "正在核对素材并打包…";
    try {
      const {fingerprint} = manifest.review;
      const intent = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte=>byte.toString(16).padStart(2,"0")).join("");
      const response = await fetch("/studio/api/projects/"+pid+"/actions",{
        method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({action:"confirm-performance",fingerprint,intent,note:document.querySelector("#performance-note").value}),
      });
      const project = await response.json();
      if (!response.ok) throw new Error(project.error);
      showDownload({...project.performance,download:"/studio/api/projects/"+pid+"/releases/"+fingerprint+".zip"});
      report.textContent = "";
    } catch (err) {
      report.textContent = err.message;
      button.disabled = false;
    }
  };
}

function renderClip(job, mediaTime) {
  const {clip} = job;
  const video = clip.element;
  ctx.drawImage(video,0,0,width,width);
  const mouth=mouthAt();
  const level=Math.round(mouth*4);
  let trackFrame=null;
  const mouthTrack = mouthTracks[route(clip.source,clip.to)];
  if (mouthTrack) {
    trackFrame=Math.min(mouthTrack.positions.length-1,Math.round(mediaTime*mouthTrack.fps));
    if (level) {
      const [w,h]=mouthTrack.size;
      const [x,y]=mouthTrack.positions[trackFrame].coords;
      const index=trackFrame*4+level-1;
      ctx.drawImage(mouthTrack.bitmap,(index%mouthTrack.cols)*w,Math.floor(index/mouthTrack.cols)*h,
                    w,h,x,y,w,h);
    }
  }
  const remaining = video.duration - mediaTime - 1/clip.fps;
  if (mediaTime < fadeLength || remaining < fadeLength) {
    const starting=mediaTime<fadeLength;
    const amount=Math.min(1,1-Math.max(0,starting?mediaTime:remaining)/fadeLength);
    const endpoint=starting?clip.source:clip.to;
    paintPose(motionEndpoint,endpoint,{body:{left:0,right:0},mouth,blink:null,fringe:0});
    ctx.globalAlpha=amount;
    ctx.drawImage(motionEndpoint.canvas,0,0,width,width);
    ctx.globalAlpha=1;
  }
  activeControls={...activeControls,mouthIndex:level,trackFrame,mediaTime,
    trackCoords:trackFrame === null ? null : mouthTrack.positions[trackFrame].coords};
}

function travel(to) {
  if (motion || (spoken && !mouthTracks[route(pose,to)])) return Promise.resolve("busy");
  if (to === pose) return Promise.resolve("idle");
  const clip = clips[route(pose,to)];
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
      if (scheduled !== undefined) video.cancelVideoFrameCallback(scheduled);
      video.pause();
      if (result === "complete") {
        pose = clip.to;
        arrival = now();
        if (nextAuto <= arrival) nextAuto = arrival + intervalMs;
        enterPose();
        const lastVideoLevel=activeControls?.mouthIndex ?? 0;
        activeControls = {...soft.sample(arrival), ...paintPose(ctx,pose,{
          body:{left:0,right:0},mouth:mouthAt(),blink:null,fringe:0}),
          trackFrame:null,mediaTime:null,trackCoords:null};
        events.push({phase:"mouthHandoff",pose,atMs:now(),lastVideoLevel,level:activeControls.mouthIndex,
                     voiceActive:Boolean(spoken?.analyser)});
      } else {
        ctx.drawImage(snapshot,0,0);
      }
      motion = null;
      log(result === "complete" ? "idle" : result,
          {from:clip.source,to:clip.to,frameCount:job.frameCount});
      refresh();
      resolve(result);
    }
    const frame = (_, metadata) => {
      job.mediaTime=metadata.mediaTime;
      job.frameCount++;
      renderClip(job,metadata.mediaTime);
      scheduled = video.requestVideoFrameCallback(frame);
    };
    job.cancel = () => finish("cancel");
    motion = job;
    log("transition",{from:clip.source,to:clip.to,rate:clip.rate});
    refresh();
    const options = {signal:handlers.signal,once:true};
    video.playbackRate = clip.rate;
    video.currentTime = 0;
    video.addEventListener("ended",() => finish("complete"),options);
    video.addEventListener("error",() => finish("failure"),options);
    watchdog = setTimeout(() => finish("failure"),Math.ceil(video.duration*1000/clip.rate)+1900);
    scheduled = video.requestVideoFrameCallback(frame);
    video.play().catch(() => finish("failure"));
  });
  return job.done;
}

try {
  await Promise.all(Object.entries(manifest.tracks).map(async ([id, info]) => {
    if (info.sourceSha256 !== manifest.clips[id].sha256) throw Error("Wrong lip-track source");
    mouthTracks[id] = {...info,bitmap:await bitmap(manifestURL,{file:info.image,sha256:info.sha256})};
  }));
  await Promise.all([
    ...Object.entries(manifest.poses).map(async ([name,view]) => { images[name] = await loadPose(view); }),
    ...Object.entries(manifest.clips).map(async ([name,clip]) => {
      if (!manifest.poses[clip.source] || !manifest.poses[clip.to] ||
          clip.endpoints[0] !== manifest.poses[clip.source].baseSha256 ||
          clip.endpoints[1] !== manifest.poses[clip.to].baseSha256) throw new Error("Invalid endpoints "+name);
      try { clips[name] = await loadVideo(clip); }
      catch { clips[name] = {...clip,disabled:true}; }
    }),
  ]);
  const blinkOnce = () => { lastBlink = now(); nextAuto = lastBlink+intervalMs; };
  const hit = (intensity,side="both") => softEvent("softbody.impact",intensity,side);
  const breath = intensity => softEvent("softbody.breath",intensity);
  window.projectPlayer = {
    travel,say,blinkOnce,tuneBlink,hit,breath,initAudio,time:now,
    cancel: () => motion?.cancel(),
    snapshot: () => ({...activeControls,breathPhase:activeControls?.phase,
                       audioPosition:spoken?.startedAt === undefined ? null : audioContext.currentTime-spoken.startedAt,
                       audioRms:spoken?.rms ?? null,
                       pose,voiceActive:Boolean(spoken?.analyser),phase:motion?"transition":spoken?"speak":"idle"}),
    events,
    previewFrame(name, controls) {
      const probe = canvas(controls.native ? images[name].full.width : width);
      paintPose(probe.getContext("2d"),name,controls);
      return probe.toDataURL();
    },
  };
  for (const button of document.querySelectorAll("[data-pose]"))
    button.addEventListener("click",() => travel(button.dataset.pose));
  document.querySelector("#cancel").onclick = window.projectPlayer.cancel;
  document.querySelector("#voice").onclick = () => say(0);
  document.querySelector("#blink").onclick = blinkOnce;
  document.querySelector("#breath").onchange = event => breath(event.target.value);
  document.querySelector("#hit").onclick = () =>
    hit(document.querySelector("#impact").value, document.querySelector("#impact-side")?.value ?? "both");
  document.querySelector("#restart")?.addEventListener("click", () => location.reload());
  document.querySelector("#duration").onchange = event => tuneBlink({durationMs:Number(event.target.value)});
  document.querySelector("#interval").onchange = event => tuneBlink({intervalMs:Number(event.target.value)});
  arrival = now();
  enterPose();
  log("idle");
  refresh();
  setupConfirmation();
  update();
} catch (error) {
  status.value = tr("载入失败","Could not load character");
  console.error(error);
}
