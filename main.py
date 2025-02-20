from fastapi import FastAPI, HTTPException, Request, UploadFile, Form
from fastapi.staticfiles import StaticFiles
from jinja2_fragments.fastapi import Jinja2Blocks
import json
import os
import asyncio

# Constants
AUDIO_FILE_PATH = "audio_files"
STATE_FILE = "chunk_state.json"

# Initialize FastAPI
app = FastAPI()
app.mount("/static", StaticFiles(directory="static"), name="static")
templates = Jinja2Blocks(directory="templates")


# State is just a metadata file that keeps track of the last chunk received for each stream


def load_state():
    """Load chunk state from JSON file"""
    try:
        with open(STATE_FILE, "r") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        print("No state file found or empty state, starting fresh")
        return {}


def save_state(state):
    """Save chunk state to JSON file"""
    with open(STATE_FILE, "w") as f:
        json.dump(state, f)
        print(f"Saved state: {state}")


async def write_chunk(audio: UploadFile, stream_id: str, is_first_chunk: bool):
    """Write audio chunk to file, or create new file if first chunk"""
    if not os.path.exists(AUDIO_FILE_PATH):
        os.makedirs(AUDIO_FILE_PATH)
        print(f"Created audio directory: {AUDIO_FILE_PATH}")

    mode = "wb" if is_first_chunk else "ab"
    output_file = f"{AUDIO_FILE_PATH}/{stream_id}.webm"

    with open(output_file, mode) as file:
        chunk_data = await audio.read()
        file.write(chunk_data)
        print(f"Wrote chunk to {output_file} (mode: {mode})")


# Home page
@app.get("/")
def read_root(request: Request):
    return templates.TemplateResponse("index.html", {"request": request})


# Recieve a chunk for an arbitrary stream
@app.post("/chunk")
async def receive_chunk(
    audio: UploadFile,
    chunk_index: int = Form(...),
    stream_id: str = Form(...),
):
    print(f"\nReceived chunk {chunk_index} for stream {stream_id}")

    # Handle first chunk
    if chunk_index == 0:
        print(f"First chunk for stream {stream_id}, creating new file")
        await write_chunk(audio, stream_id, is_first_chunk=True)
        state = load_state()
        state[stream_id] = 0
        save_state(state)
        return {"status": "success"}

    # Wait for previous chunk
    # NOTE: This is the part you'll need to do differently if we don't want this stuff in memory
    # Bright side, is even on a backend restart, because the front end hasn't got confirmation of the chunk, it will resend it
    for attempt in range(10):  # 10 second timeout
        state = load_state()
        print(
            f"Attempt {attempt + 1}: Checking for chunk {chunk_index-1}. Current state: {state.get(stream_id, 'not found')}"
        )

        if stream_id not in state:
            print(f"No state found for stream {stream_id}")
            raise HTTPException(
                status_code=400, detail=f"Stream {stream_id} not initialized"
            )

        if state[stream_id] == chunk_index - 1:
            print(f"Previous chunk confirmed, writing chunk {chunk_index}")
            await write_chunk(audio, stream_id, is_first_chunk=False)
            state[stream_id] += 1
            save_state(state)
            return {"status": "success"}
        if state[stream_id] > chunk_index - 1:
            print(f"Chunk {chunk_index-1} already received")
            return {"status": "success"}

        print(f"Waiting for chunk {chunk_index-1}...")
        await asyncio.sleep(1)

    print(f"Timeout waiting for chunk {chunk_index-1}")
    raise HTTPException(
        status_code=400, detail=f"Timeout waiting for chunk {chunk_index-1}"
    )
