import {createPortrait} from "./portrait-runtime.mjs";

const manifestURL = new URL("./manifest.json",import.meta.url);
const response = await fetch(manifestURL);
if (!response.ok) throw new Error("缺少角色清单");
const manifest = await response.json();
const byId = name => document.getElementById(name);
const lookPicker = byId("look");
const aspectPicker = byId("aspect");
const status = byId("status");
const slot = byId("portrait");
const mouth = byId("mouth");
const breath = byId("breath");
const hit = byId("hit");
const blink = byId("blink");
const clock = performance.now();
const now = () => Math.floor(performance.now()-clock);
const key = look => look.characterId+"/"+look.appearanceId;
let revision = 0, eventId = 0, active;
const options = (picker, entries) => picker.replaceChildren(...entries.map(([value,label])=>new Option(label,value)));
options(lookPicker,manifest.looks.map(look=>[key(look),look.name+" · "+look.outfit]));

function update() {
  active?.portrait.render(now(),Number(mouth.value));
  requestAnimationFrame(update);
}

async function choose(lookKey, preferred) {
  const ticket = ++revision;
  const look = manifest.looks.find(item=>key(item)===lookKey);
  if (!look) throw new Error("未知角色");
  const aspect = Object.hasOwn(look.views,preferred) ? preferred : Object.keys(look.views)[0];
  const view = look.views[aspect];
  lookPicker.value = lookKey;
  options(aspectPicker,Object.entries(look.views).map(([ratio,row])=>[ratio,ratio+" · "+row.framing]));
  aspectPicker.value = aspect;
  status.value = "载入中";
  const canvas = document.createElement("canvas");
  const id = "preview-"+ticket;
  const portrait = await createPortrait(canvas,view,manifestURL,id);
  if (revision!==ticket) {
    portrait.close();
    return;
  }
  active?.portrait.close();
  active = {look:lookKey,aspect,id,view,portrait};
  slot.replaceChildren(canvas);
  mouth.value = view.idleIndex;
  breath.value = "medium";
  const capabilities = ["口型"];
  breath.disabled = hit.disabled = !view.runtime.softbody;
  blink.disabled = !view.runtime.blink.atlas;
  if (view.runtime.softbody) capabilities.push("呼吸","受击");
  if (view.runtime.blink.atlas) capabilities.push("眨眼");
  if (view.runtime.hair) capabilities.push("发丝摆动");
  status.value = capabilities.join(" · ");
  return {look:lookKey,aspect,capabilities};
}

function dispatch(type,fields={}) {
  if (!active) return;
  return active.portrait.event({version:1,type,instanceId:active.id,eventId:"preview-"+(++eventId),atMs:now(),...fields});
}

function selectCurrent() {
  choose(lookPicker.value,aspectPicker.value).catch(error => { status.value = error.message; });
}
lookPicker.onchange = selectCurrent;
aspectPicker.onchange = selectCurrent;
breath.onchange = () => dispatch("softbody.breath",{intensity:breath.value});
hit.onclick = () => dispatch("softbody.impact",{intensity:"high",side:"both"});
blink.onclick = () => dispatch("blink.once");

await choose(key(manifest.looks[0]),manifest.defaultAspect);
window.portraitGallery = {
  choose,dispatch,
  list:() => manifest.looks.flatMap(look=>Object.keys(look.views).map(aspect=>({key:key(look),aspect}))),
};
update();
