// A host supplies scene time. Sampling twice at the same time is side-effect free.
export const levels = ["low", "medium", "high"];
export const sides = ["left", "right", "both"];
export const version = 1;
const maxId = 128;
const fields = ["version","type","instanceId","eventId","atMs","intensity","side"];

const clamp = a => Math.max(0, Math.min(1, a));
const ease = a => { const v = clamp(a); return v*v*(3-2*v); };

export function presets(lightGain) {
    const hit = (peak, frequency, damping, durationMs, attackMs) => ({
        peak: peak*lightGain, frequency, damping, durationMs, attackMs
    });
    return {
        impact: {
            low: hit(.48, 1.89, 3.75, 1500, 135),
            medium: hit(.73, 1.65, 3.04, 1970, 145),
            high: hit(1.03, 1.37, 2.47, 2550, 155),
        },
        breath: {low:.108, medium:.252, high:.44},
        breathRampMs: 580,
    };
}

export function response(age, profile) {
    if (age<=0 || age>=profile.durationMs) return 0;
    const seconds = age/1000;
    const omega = 2*Math.PI*profile.frequency;
    const peakAt = Math.atan2(omega, profile.damping)/omega;
    const naturalPeak = Math.sin(omega*peakAt)*Math.exp(-profile.damping*peakAt);
    const pulse = Math.sin(omega*seconds)*Math.exp(-profile.damping*seconds)/naturalPeak;
    const attack = ease(age/profile.attackMs);
    const tail = 1-ease((age-(profile.durationMs-410))/410);
    return profile.peak*pulse*attack*tail;
}

export function compose(air, hit) {
    if (hit===0) return air;
    const budget = hit>0 ? 1-air : 1+air;
    if (budget<=0) return air;
    const knee = .73*budget;
    const rem = budget-knee;
    const mag = Math.abs(hit);
    return air+Math.sign(hit)*(mag<=knee ? mag : knee-rem*Math.expm1(-(mag-knee)/rem));
}

function supports(view, event) {
    if (!view) return "view_unavailable";
    if (view.state==="region_not_visible") return "region_not_visible";
    if (event.type==="softbody.breath") {
        return view.breathLevels.includes(event.intensity) ? null : "level_unavailable";
    }
    const available = view.impact[event.intensity];
    if (!available) return "level_unavailable";
    return available.includes(event.side) ? null : "side_unavailable";
}

function validId(id) { return typeof id==="string" && id.length>0 && id.length<=maxId; }

export class Softbody {
    constructor(instanceId, capability, curves) {
        if (!validId(instanceId)) throw new TypeError("Invalid instanceId");
        this.instanceId=instanceId;
        this.initial={capability,curves};
        this.reset();
    }

    reset() {
        this.view=this.initial.capability;
        this.curves=this.initial.curves;
        this.received=new Map();
        this.events=[];
        this.now=0;
        this.paused=false;
        this.outfitAt=0;
        this.carryBreath=null;
    }

    tick(atMs) {
        if (!Number.isSafeInteger(atMs) || atMs<this.now) throw new RangeError("Rebuild before seeking backwards");
        if (!this.paused) this.now=atMs;
        return this.sample(this.now);
    }

    setPaused(paused) { this.paused=Boolean(paused); }

    receive(input, {replay=false}={}) {
        if (!input || !validId(input.eventId)) throw new TypeError("Transport must supply eventId");
        const {eventId} = input;
        const receipt = status => ({version,instanceId:this.instanceId,eventId,status});
        const hit = input.type==="softbody.impact";
        const breath = input.type==="softbody.breath";
        if (input.version!==version || (!hit&&!breath) || input.instanceId!==this.instanceId ||
            !Number.isSafeInteger(input.atMs) || input.atMs<0 || !levels.includes(input.intensity) ||
            Object.keys(input).some(key => !fields.includes(key)) ||
            (Object.hasOwn(input,"side") && (!hit || !sides.includes(input.side)))) {
            return receipt("invalid");
        }
        const event = {type:input.type,eventId,atMs:input.atMs,intensity:input.intensity,
            ...(hit ? {side:input.side??"both"} : {})};
        const key = JSON.stringify(event);
        if (this.received.has(eventId)) return receipt(this.received.get(eventId)===key?"duplicate":"event_id_conflict");
        const reason = supports(this.view,event);
        if (reason) return {...receipt("unsupported"),reason};
        this.received.set(eventId,key);
        if (!replay && hit && (event.atMs<this.outfitAt ||
            this.now-event.atMs>=this.curves.impact[event.intensity].durationMs)) return receipt("expired");
        this.events.push(event);
        this.events.sort((a,b)=>a.atMs-b.atMs); // Stable sort preserves event-log order within a tick.
        return receipt("accepted");
    }

    rebuild(log, atMs) {
        this.reset();
        for (const event of [...log].sort((a,b)=>a.atMs-b.atMs)) {
            if (event.atMs>atMs) break;
            if (event.type==="softbody.binding") this.swap(event.capability,event.curves,event.atMs);
            else this.receive(event,{replay:true});
        }
        return this.tick(atMs);
    }

    swap(capability, curves, atMs) {
        const previous=this.breath(atMs);
        this.tick(atMs);
        this.outfitAt=atMs;
        this.carryBreath={phase:previous.phase, level:previous.level, amplitude:previous.amplitude, atMs};
        this.view=capability;
        this.curves=curves;
        // Outgoing impacts are disposed with the outgoing view.
        this.events=this.events.filter(event=>event.atMs>atMs);
    }

    breath(atMs) {
        const p=this.curves;
        let level=this.carryBreath?.level??"medium";
        let from=this.carryBreath?.amplitude??p.breath[level],to=p.breath[level],start=this.carryBreath?.atMs??0;
        const amplitude = time => from+(to-from)*ease((time-start)/p.breathRampMs);
        for (const e of this.events) {
            if (e.atMs>atMs) break;
            if (e.type!=="softbody.breath" || e.intensity===level) continue;
            from=amplitude(e.atMs);
            level=e.intensity;
            to=p.breath[level];
            start=e.atMs;
        }
        const origin=this.carryBreath?.atMs??0;
        const phase=((this.carryBreath?.phase??0)+(atMs-origin)/this.curves.periodMs)%1;
        const inhale=this.curves.inhaleFraction;
        const air=phase<inhale ? ease(phase/inhale) : 1-ease((phase-inhale)/(1-inhale));
        const gain=amplitude(atMs);
        return {air:air*gain, phase, level, amplitude:gain};
    }

    sample(atMs=this.now) {
        const {air,phase,level}=this.breath(atMs);
        let left=0,right=0;
        for (const e of this.events) {
            if (e.atMs>atMs) break;
            if (e.type!=="softbody.impact" || e.atMs<this.outfitAt) continue;
            const value=response(atMs-e.atMs,this.curves.impact[e.intensity]);
            if (e.side!=="right") left+=value;
            if (e.side!=="left") right+=value;
        }
        const available=1-Math.abs(air);
        left*=available;
        right*=available;
        return {left:compose(air,left),right:compose(air,right),air,phase,level,leftHit:left,rightHit:right};
    }
}
