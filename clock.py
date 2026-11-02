import asyncio
import collections
import datetime
import json
import time
from aiohttp import web
from winrt.windows.media.control import (
    GlobalSystemMediaTransportControlsSessionManager as SessionManager
)

current_data = {
    "position_ms": 0,
    "duration_ms": 0,
    "server_time_ms": 0
}

connected_websockets = set()

# ── Track metadata relay (Spicetify extension -> wallpaper) ──────────────
# time-transferrer.js (running inside Spotify) sends {cover, isrc, track}.
# We relay it to every OTHER client as {"type": "track_meta", "data": ...},
# and remember the latest one so a wallpaper that connects (or reconnects)
# AFTER Spotify already announced the track still gets it immediately.
last_track_meta = None
# Sockets that have sent track metadata, i.e. the Spicetify extension. When
# the last one disconnects, Spotify is gone and the cached metadata is stale.
meta_sources = set()

# How often we actually push a position_update over the websocket. The poll
# loop below still runs every 10ms so play/pause/skip stay responsive, but we
# don't need to broadcast that fast -- the client interpolates smoothly
# between updates via requestAnimationFrame. Sending less often also shrinks
# the window in which a single glitchy OS-reported timestamp can reach the
# client and look like "drift".
SEND_INTERVAL_S = 0.15

# Windows' playback_status can flicker for a single poll around play/pause
# transitions. A short majority-vote history smooths that out so a lone bad
# reading doesn't toggle is_playing (and therefore the position math) for
# just one tick.
_playing_history = collections.deque(maxlen=3)

_last_sent_time = 0.0

def _fmt_mmss(ms):
    total_s = max(0, ms) // 1000
    return f"{total_s // 60:02d}:{total_s % 60:02d}"

def _print_status_line(data):
    # \r moves the cursor back to the start of the line instead of advancing
    # to a new one, so this overwrites in place each time rather than
    # scrolling. Fields are padded to a fixed width so only the digits/state
    # visibly change, not the layout around them. end="" + flush=True are
    # required for \r to work -- print()'s default newline would defeat it.
    state = "▶ playing" if data.get("is_playing") else "⏸ paused "
    pos = _fmt_mmss(data.get("position_ms", 0))
    dur = _fmt_mmss(data.get("duration_ms", 0))
    clients = len(connected_websockets)
    line = f"[WS] {state} | {pos} / {dur} | clients: {clients:<2}"
    print(f"\r{line}", end="", flush=True)

async def update_media_info(manager):
    global current_data, _last_sent_time
    while True:
        try:
            session = manager.get_current_session()
            if session:
                timeline = session.get_timeline_properties()
                if timeline:
                    base_position_ms = int(timeline.position.total_seconds() * 1000)
                    last_update = timeline.last_updated_time
                    now_utc = datetime.datetime.now(datetime.timezone.utc)
                    elapsed_ms = int((now_utc - last_update).total_seconds() * 1000)
                    
                    playback_info = session.get_playback_info()
                    raw_is_playing = bool(playback_info and playback_info.playback_status == 4)

                    # Majority-vote over the last few polls instead of trusting
                    # a single reading, so one flickered status doesn't
                    # momentarily change whether elapsed_ms gets added on top
                    # of base_position_ms.
                    _playing_history.append(raw_is_playing)
                    is_playing = sum(_playing_history) > len(_playing_history) // 2
                    
                    if is_playing:
                        true_position_ms = base_position_ms + elapsed_ms
                    else:
                        true_position_ms = base_position_ms
                        
                    max_duration_ms = int(timeline.end_time.total_seconds() * 1000)
                    true_position_ms = max(0, min(true_position_ms, max_duration_ms))
                    
                    current_data.update({
                        "position_ms": true_position_ms,
                        "duration_ms": max_duration_ms,
                        "is_playing": is_playing,
                        "server_time_ms": int(time.time() * 1000)
                    })
            else:
                _playing_history.clear()
                current_data.update({
                    "position_ms": 0,
                    "duration_ms": 0,
                    "is_playing": False,
                    "server_time_ms": int(time.time() * 1000)
                })

            now = time.time()
            if (now - _last_sent_time) >= SEND_INTERVAL_S:
                if connected_websockets:
                    payload = json.dumps({
                        "type": "position_update",
                        "data": current_data
                    })
                    await asyncio.gather(
                        *[ws.send_str(payload) for ws in list(connected_websockets)],
                        return_exceptions=True
                    )
                _last_sent_time = now
                _print_status_line(current_data)

        except Exception:
            pass
        # Keep the poll itself tight so play/pause/skip commands still feel
        # instant -- only the *send*/print are throttled above.
        await asyncio.sleep(0.01)

# Handle incoming media action commands
async def process_media_command(manager, action, value=None):
    session = manager.get_current_session()
    if not session:
        print("\n[WS] Command received but no active media session found.")
        return

    try:
        # Play / Pause Controls
        if action in ["MediaAction.PlayPause", "playpause"]:
            await session.try_toggle_play_pause_async()
            print("\n[WS] Toggled Play/Pause")
            
        elif action in ["play", "MediaAction.Play"]:
            await session.try_play_async()
            print("\n[WS] Play command executed")
            
        elif action in ["pause", "MediaAction.Pause"]:
            await session.try_pause_async()
            print("\n[WS] Pause command executed")
            
        # Track Navigation (Next / Previous)
        elif action in ["next", "MediaAction.SkipNext", "MediaAction.Next"]:
            await session.try_skip_next_async()
            print("\n[WS] Skipped to Next track")
            
        elif action in ["previous", "MediaAction.SkipPrevious", "MediaAction.Previous"]:
            await session.try_skip_previous_async()
            print("\n[WS] Skipped to Previous track")

    except Exception as err:
        print(f"\n[WS] Error executing command '{action}': {err}")

async def broadcast(payload, exclude=None):
    targets = [c for c in list(connected_websockets) if c is not exclude]
    if targets:
        await asyncio.gather(
            *[c.send_str(payload) for c in targets],
            return_exceptions=True
        )

async def handle_track_meta(ws, payload):
    global last_track_meta
    last_track_meta = {
        "cover": payload.get("cover"),
        "isrc": payload.get("isrc"),
        "track": payload.get("track"),
    }
    meta_sources.add(ws)
    track = last_track_meta.get("track") or {}
    print(f"\n[WS] track_meta: {track.get('title')} - {track.get('artist')} "
          f"| isrc={last_track_meta.get('isrc')}")
    await broadcast(json.dumps({"type": "track_meta", "data": last_track_meta}), exclude=ws)

async def websocket_handler(request):
    global last_track_meta
    ws = web.WebSocketResponse()
    await ws.prepare(request)
    
    connected_websockets.add(ws)
    print(f"\n[WS] Client connected from {request.remote}")
    manager = request.app['media_manager']

    # Late joiner: hand over whatever Spotify last announced.
    if last_track_meta:
        try:
            await ws.send_str(json.dumps({"type": "track_meta", "data": last_track_meta}))
        except Exception:
            pass

    try:
        async for msg in ws:
            if msg.type == web.WSMsgType.TEXT:
                try:
                    payload = json.loads(msg.data)
                    command = payload.get("command")
                    value = payload.get("value", None)
                    
                    if command:
                        await process_media_command(manager, command, value)
                    elif "cover" in payload or "isrc" in payload or "track" in payload:
                        await handle_track_meta(ws, payload)
                except json.JSONDecodeError:
                    print(f"[WS] Non-JSON message received: {msg.data}")
            elif msg.type == web.WSMsgType.ERROR:
                print(f'[WS] Connection closed with exception: {ws.exception()}')
    finally:
        connected_websockets.discard(ws)
        was_source = ws in meta_sources
        meta_sources.discard(ws)
        print("\n[WS] Client disconnected")
        # Spotify/Spicetify went away: the cached track is stale. Tell the
        # wallpaper (data = null) so it stops trusting that ISRC and cover.
        if was_source and not meta_sources:
            last_track_meta = None
            await broadcast(json.dumps({"type": "track_meta", "data": None}))

    return ws

async def main():
    manager = await SessionManager.request_async()
    print("Windows Media Controls manager acquired.")
    
    asyncio.create_task(update_media_info(manager))

    app = web.Application()
    app['media_manager'] = manager
    app.router.add_get('/ws', websocket_handler)

    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, '127.0.0.1', 5002)
    await site.start()
    
    print("Server running on ws://127.0.0.1:5002/ws")
    await asyncio.Event().wait()

if __name__ == "__main__":
    asyncio.run(main())