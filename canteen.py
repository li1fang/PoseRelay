"""Inspect prepared Live2D assets, collect decisions and assemble a portable sample."""
import argparse
from hashlib import sha256
import json
from pathlib import Path, PurePosixPath
import re
import shutil
import struct
from tempfile import TemporaryDirectory
import wave


HERE = Path(__file__).resolve().parent
POSES = ("A", "B", "D")
ROUTES = {a+b for a in POSES for b in POSES if a != b}
RUNTIMES = {
    "claude": ("index.html", "stage.mjs", "softbody-v1.mjs", "canvas-v1.mjs"),
    "portraits": ("index.html", "gallery.mjs", "portrait-runtime.mjs", "softbody-v1.mjs", "canvas-v1.mjs"),
}


def read(path):
    return json.loads(path.read_text(encoding="utf-8"))


def write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def digest(path):
    return sha256(path.read_bytes()).hexdigest()


def signature(value):
    raw = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    return sha256(raw).hexdigest()


def require(condition, message):
    if not condition:
        raise ValueError(message)


def source_file(root, name):
    path = PurePosixPath(name)
    require(not path.is_absolute() and path.as_posix() == name and path.parts
            and all(re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", part) for part in path.parts), f"Bad path: {name}")
    source = root.joinpath(*path.parts)
    require(source.resolve().is_relative_to(root.resolve()) and source.is_file(), f"Missing asset: {name}")
    return source


def media_file(root, name, wanted, files):
    path = source_file(root, name)
    actual = digest(path)
    require(actual == wanted, f"Hash mismatch: {name}")
    files[name] = actual
    return path


def png_size(path):
    with path.open("rb") as stream:
        first = stream.read(24)
    require(len(first) == 24 and first[:8] == b"\x89PNG\r\n\x1a\n" and first[12:16] == b"IHDR",
            f"Invalid PNG header: {path.name}")
    return struct.unpack(">II", first[16:24])


def boxes(data):
    start = 0
    while start < len(data):
        require(len(data)-start >= 8, "Truncated MP4 box")
        size, tag = struct.unpack_from(">I4s", data, start)
        header = 8
        if size == 1:
            require(len(data)-start >= 16, "Truncated MP4 extended box")
            size = struct.unpack_from(">Q", data, start+8)[0]
            header = 16
        if size == 0:
            size = len(data)-start
        require(header <= size <= len(data)-start, "Invalid MP4 box size")
        yield tag, data[start+header:start+size]
        start += size


def atom(data, tag):
    found = [body for name, body in boxes(data) if name == tag]
    require(len(found) == 1, f"Expected one MP4 {tag.decode()} box")
    return found[0]


def mp4_video(path, fps):
    # The handoff format uses a single, silent, constant-rate MP4 video track.
    raw = memoryview(path.read_bytes())
    movie = atom(raw, b"moov")
    track = atom(movie, b"trak")
    media = atom(track, b"mdia")
    require(bytes(atom(media, b"hdlr")[8:12]) == b"vide", f"Expected one video-only track: {path.name}")
    tkhd = atom(track, b"tkhd")
    width, height = struct.unpack_from(">II", tkhd, len(tkhd)-8)
    require((width, height) == (512<<16, 512<<16), f"Expected a 512 px square video: {path.name}")
    mdhd = atom(media,b"mdhd")
    require(mdhd[0] in (0,1), "Unsupported MP4 time header")
    scale = struct.unpack_from(">I",mdhd,12 if mdhd[0]==0 else 20)[0]
    entries = atom(atom(atom(media,b"minf"),b"stbl"),b"stts")
    count = struct.unpack_from(">I",entries,4)[0]
    require(len(entries) == 8+count*8 and count>0, "Invalid MP4 frame time table")
    timing = list(struct.iter_unpack(">II",entries[8:]))
    require(scale>0 and all(n>0 and step*fps==scale for n,step in timing), f"Variable or wrong frame rate: {path.name}")
    return sum(n for n,_ in timing)


def checked_rect(rect, size, label):
    x,y,w,h = rect
    require(x>=0 and y>=0 and w>0 and h>0 and x+w<=size[0] and y+h<=size[1], f"Out of bounds: {label}")
    return w,h


def softbody_files(root, view, prefix, files, size, base_sha):
    require(view["size"] == list(size) and view["baselineSha256"] == base_sha and view["assetPath"] == prefix,
            "Softbody uses a different neutral image or projection")
    windows = {}
    for side in ("left","right"):
        x,y,r,b = view["windows"][side]
        w,h = checked_rect((x,y,r-x,b-y), size, side)
        windows[side] = (x,y,r,b)
        name = view["files"][side]
        field = media_file(root,prefix+name,view["checksums"][name],files)
        require(field.stat().st_size == 2*w*h*5*4, f"Wrong deformation map size: {field.name}")
    require(windows["right"][2]<=windows["left"][0], "Overlapping softbody sides")


def inspect_claude(root, manifest):
    files, items = {}, {}
    require(set(manifest["poses"]) == set(POSES), "Expected A, B and D")
    require(set(manifest["clips"]) == ROUTES, "Expected six directed transitions")
    require(manifest["version"] == 1, "Unsupported three-pose manifest")
    for key,pose in manifest["poses"].items():
        prefix = key+"/"
        base = media_file(root,prefix+pose["base"],pose["baseSha256"],files)
        size = png_size(base)
        require(size[0] == size[1] and size[0] > 0,"Expected a square pose")
        for kind in ("eyes","mouth","fringe"):
            layer = pose[kind]
            w,h = checked_rect(layer["rect"],size,kind)
            atlas = media_file(root,prefix+layer["file"],layer["sha256"],files)
            require(layer["frames"]>=2 and png_size(atlas)==(w*layer["frames"],h), f"Invalid atlas: {atlas.name}")
        softbody_files(root,pose["softbody"],prefix,files,size,pose["baseSha256"])
        items[f"pose/{key}"] = {"sha256":signature(pose),"media":prefix+base.name,
                               "check":"说完闭口、眨眼和刘海、呼吸和受击、手脸及衣缘"}
    for direction,clip in manifest["clips"].items():
        start,end = direction
        endpoint_sha = [manifest["poses"][state]["baseSha256"] for state in (start,end)]
        require(clip["from"]+clip["to"] == direction and clip["endpoints"] == endpoint_sha,
                f"Wrong pose binding: {direction}")
        path = media_file(root,clip["file"],clip["sha256"],files)
        require(clip["fps"] == 24, f"Wrong rate: {direction}")
        frame_count = mp4_video(path,24)
        items[f"transition/{direction}"] = {"sha256":signature(clip),"media":clip["file"],
                                           "seconds":round(frame_count/24,3),
                                           "check":"原速看开始、全程和抵达，检查眼睑、扣位、手与衣服"}
    require(set(manifest["voices"]) == {"short.wav","long.wav"}, "Expected short.wav and long.wav")
    for name, entry in manifest["voices"].items():
        audio = media_file(root,entry["file"],entry["sha256"],files)
        require(audio.name == name, "Voice key and path differ")
        with wave.open(str(audio)) as stream:
            require(stream.getnframes()>0 and stream.getframerate()>0, "Empty WAV")
    return files,items


def inspect_portraits(root, manifest):
    files, items = {}, {}
    require(manifest["contractVersion"] == 1 and manifest["steps"] == 13, "Unsupported portrait format")
    require(manifest["runtimeEntry"] == "portrait-runtime.mjs", "Invalid portrait renderer")
    # Runtime code comes from the distribution, while image and field hashes bind
    # the supplied payload.
    runtime = set(RUNTIMES["portraits"])
    for name,wanted in manifest["files"].items():
        if name not in runtime:
            media_file(root,name,wanted,files)
    for look in manifest["looks"]:
        key = f'{look["characterId"]}/{look["appearanceId"]}'
        for aspect,view in look["views"].items():
            subkey = key+"/"+aspect
            require(subkey not in items,"Duplicated portrait profile")
            size = tuple(view["size"])
            base = media_file(root,view["base"],view["baseSha256"],files)
            atlas = media_file(root,view["atlas"],view["atlasSha256"],files)
            w,h = checked_rect(view["rect"],size,subkey)
            require(png_size(base)==size and png_size(atlas)==(w*manifest["steps"],h), f"Wrong portrait view: {subkey}")
            meta = view["runtime"]
            require(meta["landmarks"]["neutralSha256"]==view["baseSha256"], f"Unbound points: {subkey}")
            optional = meta["softbody"]
            if optional:
                prefix = PurePosixPath(view["base"]).parent.as_posix()+"/"
                softbody_files(root,optional,prefix,files,size,view["baseSha256"])
            hair = meta.get("hair")
            if hair:
                hfile = media_file(root,hair["file"],hair["sha256"],files)
                x,y,r,b = hair["bounds"]
                w,h = checked_rect((x,y,r-x,b-y),size,subkey+" hair")
                require(hfile.stat().st_size==w*h*8, "Invalid hair deformation length")
            blink = meta["blink"]["atlas"]
            if blink:
                eye = media_file(root,blink["file"],blink["sha256"],files)
                w,h = checked_rect(blink["rect"],size,subkey+" blink")
                require(png_size(eye)==(w*meta["blink"]["frameCount"],h), "Invalid blink atlas size")
            items[subkey] = {"sha256":signature(view),"media":view["base"],"check":"核对画幅、口型和声明的可用动作"}
    return files,items


def inspect(root):
    manifest = read(root/"manifest.json")
    kind = "claude" if "poses" in manifest else "portraits"
    decoder = inspect_claude if kind == "claude" else inspect_portraits
    files,items = decoder(root,manifest)
    return manifest, {"version":1,"kind":kind,"manifestSha256":digest(root/"manifest.json"),
                      "files":files,"items":items}


def review_template(inventory, old=None, mode=None):
    mode = mode or (old or {}).get("mode","manual")
    existing = old if old and old["mode"]==mode else {}
    previous = existing.get("entries",{})
    return {"version":1,"mode":mode,"reviewer":existing.get("reviewer",""),
            "purpose":existing.get("purpose","review"),"entries":{
                name: previous[name] if previous.get(name,{}).get("sha256")==row["sha256"]
                else {"sha256":row["sha256"],"decision":"pending","note":"","seconds":None}
                for name,row in inventory["items"].items()
            }}


def package(source, reviewed, dest):
    manifest, inventory = inspect(source)
    decisions = read(reviewed)
    kind = inventory["kind"]
    require(decisions["version"]==1 and decisions["mode"] in ("manual","api") and decisions["reviewer"].strip(),
            "Choose a review mode and name the reviewer")
    require(set(decisions["entries"])==set(inventory["items"]), "Review scope does not match the source")
    for name,row in inventory["items"].items():
        entry = decisions["entries"][name]
        require(entry["decision"]=="approved" and entry["sha256"]==row["sha256"], f"Review pending or stale: {name}")
    require(not dest.exists(), f"Use a new output directory: {dest}")
    dest.parent.mkdir(parents=True,exist_ok=True)
    with TemporaryDirectory(prefix=".canteen-",dir=dest.parent) as temporary:
        stage = Path(temporary)/"bundle"
        stage.mkdir()
        for name in sorted(inventory["files"]):
            target = stage/name
            target.parent.mkdir(parents=True,exist_ok=True)
            shutil.copyfile(source_file(source,name),target)
        for name in RUNTIMES[kind]:
            shutil.copyfile(HERE/"runtime"/kind/name,stage/name)
        shutil.copyfile(source/"manifest.json",stage/"manifest.json")
        # Re-read the finished payload before writing its receipt.
        _, check = inspect(stage)
        require(check == inventory, "Output inventory differs")
        shutil.copyfile(reviewed,stage/"review.json")
        write(stage/"receipt.json",{"kind":kind,"manifestSha256":inventory["manifestSha256"],
                                   "items":len(inventory["items"]),"assetFiles":len(inventory["files"]),
                                   "reviewMode":decisions["mode"],"reviewPurpose":decisions["purpose"],
                                   "reviewSha256":digest(reviewed),"apiRequestsByPackager":0})
        require(not dest.exists(), f"Output already exists: {dest}")
        stage.rename(dest)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    sub=parser.add_subparsers(dest="command", required=True)
    check=sub.add_parser("inspect")
    check.add_argument("source",type=Path)
    check.add_argument("inventory",type=Path)
    template=sub.add_parser("review-template")
    template.add_argument("inventory",type=Path)
    template.add_argument("review",type=Path)
    template.add_argument("--mode",choices=("manual","api"))
    assemble=sub.add_parser("build")
    assemble.add_argument("source",type=Path)
    assemble.add_argument("review",type=Path)
    assemble.add_argument("output",type=Path)
    args=parser.parse_args()
    try:
        if args.command=="inspect":
            _, inventory = inspect(args.source)
            write(args.inventory,inventory)
            print(f'{inventory["kind"]}: {len(inventory["items"])} review items')
        elif args.command=="review-template":
            current = read(args.review) if args.review.exists() else None
            write(args.review,review_template(read(args.inventory),current,mode=args.mode))
            print(args.review)
        else:
            package(args.source,args.review,args.output)
            print(args.output)
    except (OSError,ValueError,KeyError,TypeError,struct.error,wave.Error) as error:
        parser.exit(1,f"{error}\n")


if __name__=="__main__":
    main()
