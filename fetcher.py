#!/usr/bin/env python3
"""
NexLoad Fetcher v5.0
Usage:
  python fetcher.py info     <URL> [cookies_path]
  python fetcher.py playlist <URL> [cookies_path]
  python fetcher.py dl       <URL> <format_id> <output_path> [cookies_path]
  python fetcher.py audio    <URL> <output_path> [cookies_path]

Env vars (fallback when no cookies_path arg given):
  NEXLOAD_COOKIES   path to your cookies.txt
  NEXLOAD_PROXY     socks5://host:port
  NEXLOAD_NETRC     path to .netrc
  NEXLOAD_BROWSER   chrome | firefox | edge | safari
"""

import sys, json, os, re, subprocess, shutil, traceback, multiprocessing
from pathlib import Path

# ── Utilities ─────────────────────────────────────────────────────────────────

def die(msg, code=1):
    print(json.dumps({"error": msg}), flush=True)
    sys.exit(code)

def ytdlp_bin():
    for c in ["yt-dlp", "yt_dlp", shutil.which("yt-dlp")]:
        if c and shutil.which(c): return c
    die("yt-dlp not found — install with: pip install yt-dlp")

YT = ytdlp_bin()

# Auto-tune concurrent fragments: between 2 and 8 based on CPU count
CONCURRENT_FRAGS = str(min(max(multiprocessing.cpu_count(), 2), 8))

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")

# ── Auth args ─────────────────────────────────────────────────────────────────

def auth_args(cookies_path=None):
    args = []
    cp = cookies_path or os.environ.get("NEXLOAD_COOKIES","").strip()
    if cp and Path(cp).exists():
        args += ["--cookies", cp]

    netrc = os.environ.get("NEXLOAD_NETRC","").strip()
    if netrc and Path(netrc).exists():
        args += ["--netrc","--netrc-location", netrc]

    proxy = os.environ.get("NEXLOAD_PROXY","").strip()
    if proxy: args += ["--proxy", proxy]

    browser = os.environ.get("NEXLOAD_BROWSER","").strip()
    if browser and not cp:
        args += ["--cookies-from-browser", browser]

    return args

def run(*args, timeout=120):
    try:
        p = subprocess.run(
            [YT]+list(args), stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            timeout=timeout, text=True, encoding="utf-8", errors="replace")
        if p.returncode != 0:
            raise RuntimeError(p.stderr.strip() or f"Exit {p.returncode}")
        return p.stdout, p.stderr
    except subprocess.TimeoutExpired:
        raise RuntimeError(f"Timed out after {timeout}s")

def base_args():
    return ["--no-warnings","--extractor-retries","5","--socket-timeout","30","--user-agent",UA]

# ── Format helpers ────────────────────────────────────────────────────────────

def human_size(b):
    if b is None: return None
    for u in ("B","KB","MB","GB"):
        if b < 1024: return f"{b:.1f} {u}"
        b /= 1024
    return f"{b:.1f} TB"

def classify_format(f):
    ext    = (f.get("ext") or "").lower()
    vcodec = (f.get("vcodec") or "none").lower()
    acodec = (f.get("acodec") or "none").lower()
    has_v  = vcodec not in ("none","")
    has_a  = acodec not in ("none","")
    if ext in {"mhtml","none",""}: return None

    fmt_id = str(f.get("format_id"))
    if has_v and not has_a:
        fmt_id = f"{fmt_id}+bestaudio/{fmt_id}"
        has_a  = True

    height   = f.get("height") or 0
    fps      = f.get("fps")    or 0
    tbr      = f.get("tbr")    or 0
    filesize = f.get("filesize") or f.get("filesize_approx")
    resolution = f.get("resolution") or (
        f"{height}p" if height else ("audio only" if not has_v else "unknown"))

    parts = []
    if has_v and height:
        parts.append(f"{height}p")
        if fps >= 48: parts.append(f"{int(fps)}fps")
    if ext: parts.append(ext.upper())
    if   has_v and not has_a:  parts.append("video only")
    elif has_a and not has_v:  parts.append("audio only")
    elif has_v and has_a:      parts.append("video+audio")
    if tbr: parts.append(f"{int(tbr)}kbps")

    return {
        "format_id": fmt_id, "ext": ext, "resolution": resolution,
        "height": height, "width": f.get("width") or 0,
        "fps": round(fps,1) if fps else None,
        "tbr": round(tbr,1) if tbr else None,
        "abr": round(f.get("abr") or 0,1) or None,
        "vcodec": vcodec if has_v else None,
        "acodec": acodec if has_a else None,
        "hasVideo": has_v, "hasAudio": has_a,
        "filesize": filesize, "filesize_h": human_size(filesize),
        "label": " · ".join(parts) or resolution,
        "protocol": f.get("protocol"), "format_note": f.get("format_note"),
        "is_4k": height >= 2160, "is_hd": height >= 1080,
    }

# ── Commands ──────────────────────────────────────────────────────────────────

def cmd_info(url, cookies_path=None):
    args = base_args() + ["--dump-json","--no-playlist"] + auth_args(cookies_path)
    try:
        stdout, _ = run(*(args+[url]), timeout=90)
    except RuntimeError:
        try:
            stdout, _ = run(*(base_args()+["--dump-json","--no-playlist",url]), timeout=90)
        except RuntimeError as e:
            die(f"yt-dlp info failed: {e}")

    try: raw = json.loads(stdout)
    except json.JSONDecodeError as e: die(f"JSON parse error: {e}")

    formats, seen = [], set()
    for f in (raw.get("formats") or []):
        c = classify_format(f)
        if not c: continue
        key = (c["ext"],c["height"],c["hasVideo"],c["hasAudio"],c.get("vcodec"),c.get("acodec"))
        if key in seen: continue
        seen.add(key); formats.append(c)

    formats.sort(key=lambda f: (
        0 if f["hasVideo"] and f["hasAudio"] else 1 if f["hasVideo"] else 2,
        -(f.get("height") or 0), -(f.get("tbr") or 0)))

    best_v = next((f for f in formats if f["hasVideo"] and f["hasAudio"]), None)
    best_a = next((f for f in formats if not f["hasVideo"] and f["hasAudio"]), None)

    print(json.dumps({
        "title": raw.get("title"), "thumbnail": raw.get("thumbnail"),
        "duration": raw.get("duration"), "uploader": raw.get("uploader") or raw.get("channel"),
        "view_count": raw.get("view_count"), "like_count": raw.get("like_count"),
        "upload_date": raw.get("upload_date"),
        "description": (raw.get("description") or "")[:300],
        "webpage_url": raw.get("webpage_url") or url,
        "extractor": raw.get("extractor_key") or raw.get("extractor"),
        "formats": formats,
        "best_video_format_id": best_v["format_id"] if best_v else None,
        "best_audio_format_id": best_a["format_id"] if best_a else None,
        "format_count": len(formats),
        "has_4k": any(f.get("is_4k") for f in formats),
    }, ensure_ascii=False), flush=True)


def cmd_playlist(url, cookies_path=None):
    args = base_args() + ["--dump-json","--flat-playlist","--yes-playlist"] + auth_args(cookies_path) + [url]
    try:
        stdout, _ = run(*args, timeout=120)
    except RuntimeError as e:
        die(f"Playlist fetch failed: {e}")

    entries = []
    for line in stdout.strip().splitlines():
        line = line.strip()
        if not line: continue
        try:
            e = json.loads(line)
            thumbs = e.get("thumbnails") or []
            entries.append({
                "id":        e.get("id"),
                "title":     e.get("title") or e.get("id"),
                "url":       e.get("url") or e.get("webpage_url"),
                "duration":  e.get("duration"),
                "thumbnail": e.get("thumbnail") or (thumbs[-1].get("url") if thumbs else None),
                "uploader":  e.get("uploader") or e.get("channel"),
            })
        except Exception: continue

    print(json.dumps({"entries": entries, "count": len(entries)}, ensure_ascii=False), flush=True)


def cmd_download(url, format_id, out_path, cookies_path=None):
    """
    QUALITY POLICY — ZERO RE-ENCODING.
    --remux-video changes container only. 4K/HDR/original bitrate 100% preserved.
    """
    out_tpl = str(Path(out_path).with_suffix(".%(ext)s"))
    args = base_args() + [
        "-f", format_id, "--no-playlist",
        "--retries","10","--fragment-retries","10","--retry-sleep","linear=1::2",
        "--concurrent-fragments", CONCURRENT_FRAGS,
        "--remux-video","mp4>mp4/mkv>mkv/webm>webm",  # container remux only
        "--no-post-overwrites","--audio-quality","0",
        "--merge-output-format","mp4","-o", out_tpl,
    ] + auth_args(cookies_path) + [url]

    try: run(*args, timeout=3600)
    except RuntimeError as e: die(f"Download failed: {e}")

    found = list(Path(out_path).parent.glob(f"{Path(out_path).stem}.*"))
    if not found: die("Output file not found after download")

    actual = str(found[0])
    size   = Path(actual).stat().st_size if Path(actual).exists() else 0
    if size < 1024: die(f"File too small ({size}B) — may be incomplete")

    print(json.dumps({"ok":True,"path":actual,"size":size,"size_h":human_size(size)}), flush=True)


def cmd_audio(url, out_path, cookies_path=None):
    args = base_args() + [
        "-f","bestaudio/best","--extract-audio","--audio-format","mp3","--audio-quality","0",
        "--no-playlist","--retries","10","--fragment-retries","10","--retry-sleep","linear=1::2",
        "-o", out_path,
    ] + auth_args(cookies_path) + [url]

    try: run(*args, timeout=1800)
    except RuntimeError as e: die(f"Audio download failed: {e}")

    p = Path(out_path)
    mp3 = p.with_suffix(".mp3")
    if not mp3.exists():
        found = list(p.parent.glob(f"{p.stem}*.mp3"))
        if found: mp3 = found[0]
        else: die("MP3 output not found")

    size = mp3.stat().st_size
    if size < 1024: die(f"MP3 too small ({size}B)")
    print(json.dumps({"ok":True,"path":str(mp3),"size":size,"size_h":human_size(size)}), flush=True)


if __name__ == "__main__":
    if len(sys.argv) < 3: print(__doc__); sys.exit(0)
    cmd = sys.argv[1].lower()
    try:
        if   cmd == "info":     cmd_info(sys.argv[2], sys.argv[3] if len(sys.argv)>3 else None)
        elif cmd == "playlist": cmd_playlist(sys.argv[2], sys.argv[3] if len(sys.argv)>3 else None)
        elif cmd == "dl":
            if len(sys.argv)<5: die("Usage: fetcher.py dl <URL> <format_id> <out> [cookies]")
            cmd_download(sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5] if len(sys.argv)>5 else None)
        elif cmd == "audio":
            if len(sys.argv)<4: die("Usage: fetcher.py audio <URL> <out> [cookies]")
            cmd_audio(sys.argv[2], sys.argv[3], sys.argv[4] if len(sys.argv)>4 else None)
        else: die(f"Unknown command: {cmd}")
    except SystemExit: raise
    except Exception as e:
        traceback.print_exc(file=sys.stderr)
        die(f"Unexpected error: {e}")
