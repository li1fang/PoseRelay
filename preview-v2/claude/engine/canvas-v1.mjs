// Fixed-view reference adapter. Hosts may sample Softbody and bind another renderer.
const assets = new Map();

async function loadFile(base, name) {
    const res=await fetch(new URL(name,base));
    if (!res.ok) throw new Error(name+" HTTP "+res.status);
    return res;
}

async function load(base, view) {
    const source=await loadFile(base,view.baseline);
    const blob=await source.blob();
    async function verify(bytes, expected) {
        if (!globalThis.crypto?.subtle) return bytes;
        const digest=await crypto.subtle.digest("SHA-256",bytes);
        const hash=Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,"0")).join("");
        if (hash!==expected) throw new Error("Asset fingerprint differs");
        return bytes;
    }
    await verify(await blob.arrayBuffer(),view.baselineSha256);
    const field = async name => verify(await (await loadFile(base,name)).arrayBuffer(),view.checksums[name]);
    const [plate,left,right]=await Promise.all([
        createImageBitmap(blob),
        field(view.files.left),
        field(view.files.right)
    ]);
    return {plate,fields:{left:new Float32Array(left),right:new Float32Array(right)}};
}

const limit=(x,max)=>Math.max(0,Math.min(max,x));

function panel(ctx,view,side,array) {
    const [x0,y0,x1,y1]=view.windows[side];
    const w=x1-x0,h=y1-y0,span=w*h*5;
    if (array.length!==2*span) throw new Error("Invalid field length");
    const before=ctx.getImageData(x0,y0,w,h);
    const after=ctx.createImageData(w,h);
    after.data.set(before.data);
    return value => {
        const power=Math.abs(value);
        const shade=view.shadeWeight*power*power*(3-2*power);
        const offset=value>=0?0:span;
        const dst=after.data,src=before.data;
        for (let y=0,i=0,k=offset;y<h;y++) {
            for (let x=0;x<w;x++,i+=4,k+=5) {
                const sx=limit(x-power*array[k],w-1);
                const sy=limit(y-power*array[k+1],h-1);
                const u=Math.floor(sx),v=Math.floor(sy),fx=sx-u,fy=sy-v;
                const a=(v*w+u)*4,b=(v*w+Math.min(u+1,w-1))*4;
                const d=(Math.min(v+1,h-1)*w+u)*4,e=d+(b-a);
                for (let c=0;c<3;c++) {
                    dst[i+c]=(1-fy)*((1-fx)*src[a+c]+fx*src[b+c])+
                        fy*((1-fx)*src[d+c]+fx*src[e+c])+shade*array[k+2+c];
                }
            }
        }
        ctx.putImageData(after,x0,y0);
    };
}

export async function attach(canvas,view,manifestUrl) {
    const base=new URL(view.assetPath,manifestUrl);
    if (!assets.has(base.href)) {
        const job=load(base,view).catch(error=>{assets.delete(base.href);throw error;});
        assets.set(base.href,job);
    }
    const {plate,fields}=await assets.get(base.href);
    [canvas.width,canvas.height]=view.size;
    if (plate.width!==canvas.width || plate.height!==canvas.height) throw new Error("Unexpected baseline size");
    const ctx=canvas.getContext("2d",{willReadFrequently:true});
    ctx.drawImage(plate,0,0);
    const left=panel(ctx,view,"left",fields.left);
    const right=panel(ctx,view,"right",fields.right);
    let prior={};
    return next => {
        if (prior.left!==next.left) left(next.left);
        if (prior.right!==next.right) right(next.right);
        prior=next;
    };
}
