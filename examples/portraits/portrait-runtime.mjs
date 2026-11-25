import {Softbody} from "./softbody-v1.mjs";
import {attach} from "./canvas-v1.mjs";

async function bytes(root, path, expected) {
  const response = await fetch(new URL(path, root));
  if (!response.ok) throw new Error(`Missing portrait resource ${path}`);
  const data = await response.arrayBuffer();
  if (globalThis.crypto?.subtle && expected) {
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
    if (Array.from(hash, x => x.toString(16).padStart(2, "0")).join("") !== expected)
      throw new Error(`Portrait fingerprint differs for ${path}`);
  }
  return data;
}

async function image(root, file, expected) {
  return createImageBitmap(new Blob([await bytes(root, file, expected)], {type: "image/png"}));
}

function makeCanvas(width, height) {
  return Object.assign(document.createElement("canvas"), {width, height});
}

function sprite(ctx, atlas, [x, y, width, height], index) {
  ctx.drawImage(atlas, width * index, 0, width, height, x, y, width, height);
}

function createHair(original, viewWidth, {bounds}, vectors) {
  const [x0, y0, x1, y1] = bounds;
  const width = x1 - x0, height = y1 - y0;
  if (vectors.length !== width * height * 2) throw new Error("Hair field size differs");
  const patch = makeCanvas(width, height), context = patch.getContext("2d");
  const pixels = context.createImageData(width, height), out = pixels.data;
  const indices = [];
  for (let i = 0; i < width * height; i++) {
    if (vectors[2 * i] || vectors[2 * i + 1]) {
      indices.push(i);
      out[4 * i + 3] = 255;
    }
  }
  return (target, amount) => {
    if (!amount) return;
    for (const i of indices) {
      const x = x0 + i % width - amount * vectors[2 * i];
      const y = y0 + Math.floor(i / width) - amount * vectors[2 * i + 1];
      const u = Math.floor(x), v = Math.floor(y), fx = x - u, fy = y - v;
      const a = (v * viewWidth + u) * 4, b = a + viewWidth * 4;
      for (let c = 0; c < 3; c++)
        out[4 * i + c] = (1 - fy) * ((1 - fx) * original[a + c] + fx * original[a + c + 4])
                       + fy * ((1 - fx) * original[b + c] + fx * original[b + c + 4]);
    }
    context.putImageData(pixels, 0, 0);
    target.drawImage(patch, x0, y0);
  };
}

const isBlink = type => type === "blink.once" || type === "blink.auto";

function blinkController(config, instanceId) {
  let seed = Array.from(instanceId).reduce((n, ch) => (Math.imul(n, 31) + ch.codePointAt(0)) >>> 0, 17);
  const [min, max] = config.intervalMs, starts = [];
  let latest = config.initialDelayMs;
  let renderedAt = 0;
  const events = [], received = new Map();
  function event(packet) {
    const {eventId, atMs, enabled, type} = packet;
    const automatic = type === "blink.auto";
    const receipt = status => ({version: 1, instanceId, eventId, status});
    const fields = ["version", "type", "instanceId", "eventId", "atMs"];
    if (automatic) fields.push("enabled");
    if (packet.version !== 1 || packet.instanceId !== instanceId ||
        typeof eventId !== "string" || !eventId || eventId.length > 128 ||
        !Number.isSafeInteger(atMs) || atMs < 0 || (automatic && typeof enabled !== "boolean") ||
        Object.keys(packet).some(field => !fields.includes(field))) return receipt("invalid");
    if (!config.atlas) return {...receipt("unsupported"), reason: "eye_layer_unavailable"};
    const signature = JSON.stringify([type, atMs, enabled]);
    if (received.has(eventId))
      return receipt(received.get(eventId) === signature ? "duplicate" : "event_id_conflict");
    received.set(eventId, signature);
    if (!automatic && renderedAt - atMs >= config.durationMs) return receipt("expired");
    events.push({type, atMs, enabled});
    events.sort((a, b) => a.atMs - b.atMs);
    return receipt("accepted");
  }
  function rebuild(log, atMs) {
    events.length = 0;
    received.clear();
    renderedAt = 0;
    for (const packet of log) if (packet.atMs <= atMs) event(packet);
    renderedAt = atMs;
  }
  function sample(t) {
    renderedAt = t;
    while (latest <= t || !starts.length) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      latest += min + seed % (max - min + 1);
      starts.push(latest);
    }
    const manual = events.findLast(e => e.type === "blink.once" && e.atMs <= t)?.atMs;
    const scheduled = starts.findLast(s => s <= t);
    const auto = events.findLast(e => e.type === "blink.auto" && e.atMs <= scheduled);
    const overlapsManual = manual !== undefined && scheduled >= manual && scheduled - manual < config.durationMs;
    const start = manual !== undefined && t - manual < config.durationMs ? manual
      : auto?.enabled === false || overlapsManual ? undefined : scheduled;
    return start === undefined || t >= start + config.durationMs ? -1 :
      Math.min(config.frameCount - 1, Math.floor((t - start) * config.frameCount / config.durationMs));
  }
  return {event, rebuild, sample};
}

// The host owns the clock and speech. Every instance loads the same asset version.
export async function createPortrait(canvas, view, manifestUrl, instanceId) {
  const {softbody, hair, blink, landmarks} = view.runtime;
  if (landmarks.neutralSha256 !== view.baseSha256) throw new Error("Unbound portrait landmarks");
  const [width, height] = view.size;
  const [base, mouth, eye, hairBytes] = await Promise.all([
    image(manifestUrl, view.base, view.baseSha256),
    image(manifestUrl, view.atlas, view.atlasSha256),
    blink.atlas && image(manifestUrl, blink.atlas.file, blink.atlas.sha256),
    hair && bytes(manifestUrl, hair.file, hair.sha256),
  ]);
  [canvas.width, canvas.height] = view.size;
  const context = canvas.getContext("2d");
  const body = softbody && makeCanvas(width, height);
  const drawBody = body && await attach(body, softbody, manifestUrl);
  const state = softbody && new Softbody(instanceId, softbody.capability, softbody.curves);
  let paintHair = null;
  if (hair) {
    const plate = makeCanvas(width, height).getContext("2d", {willReadFrequently: true});
    plate.drawImage(base, 0, 0);
    paintHair = createHair(plate.getImageData(0, 0, width, height).data, width, hair, new Float32Array(hairBytes));
  }
  const eyes = blinkController(blink, instanceId);
  return {
    event(packet) {
      if (isBlink(packet?.type)) return eyes.event(packet);
      return state ? state.receive(packet) : {version: 1, instanceId, eventId: packet.eventId,
                                            status: "unsupported", reason: "region_not_visible"};
    },
    rebuild(log, atMs) {
      state?.rebuild(log.filter(packet => !isBlink(packet.type)), atMs);
      eyes.rebuild(log.filter(packet => isBlink(packet.type)), atMs);
    },
    render(atMs, mouthIndex = view.idleIndex) {
      if (state) drawBody(state.tick(atMs));
      context.drawImage(body || base, 0, 0);
      if (paintHair) paintHair(context, Math.sin(Math.PI * (atMs % 4300) / 4300) ** 2);
      const eyeIndex = eye ? eyes.sample(atMs) : -1;
      if (eyeIndex >= 0) sprite(context, eye, blink.atlas.rect, eyeIndex);
      const index = Math.min(12, Math.max(0, Math.round(mouthIndex)));
      sprite(context, mouth, view.rect, index);
      return {eyeIndex, mouthIndex: index};
    },
    close() { base.close(); mouth.close(); eye?.close(); }
  };
}
