"""Local WebSocket and HTTP server for opencode-web-stream.

Capabilities:
  - Live audio/speech streaming & interim transcripts
  - Real-time agent progress events (tool calls summary, execution steps)
  - Concise speech updates for TTS without wordy monologues
  - Barge-in & trajectory redirection injection
  - Fast dynamic phonetic resolution, strict certainty gate & plocate search endpoints
  - Dynamic alias learning via SQLite (/api/learn)
  - Streamer STT Interception & Routing
"""

import asyncio
import json
import logging
from pathlib import Path
from typing import Dict, Set, Any, Optional, List

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Query, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import httpx

from indexer import StreamIndexer, DEFAULT_DB_PATH
from resolver import PhoneticResolver

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("opencode-web-stream")

app = FastAPI(title="OpenCode Web Stream Server", version="0.3.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Global singletons
indexer = StreamIndexer(DEFAULT_DB_PATH)
resolver = PhoneticResolver(DEFAULT_DB_PATH)

# Mapping from main OpenCode session_id to streamer subagent session_id
streamer_sessions: Dict[str, str] = {}


class TrajectoryRedirect(BaseModel):
    instruction: str
    target_session: Optional[str] = None
    interrupt_current: bool = True
    phonetic_normalized: Optional[str] = None


class ProgressStep(BaseModel):
    step_id: str
    title: str
    tool: Optional[str] = None
    tool_input: Optional[Dict[str, Any]] = None
    model: Optional[str] = None
    agent: Optional[str] = None
    summary: Optional[str] = ""
    full_detail: Optional[str] = None
    status: str = "running"


class LearnAliasRequest(BaseModel):
    phrase_heard: str
    canonical_target: str
    confidence: Optional[float] = 1.0


class StreamerSessionBind(BaseModel):
    main_session: str
    streamer_session: str


class ConnectionManager:
    def __init__(self):
        self.active_connections: Set[WebSocket] = set()

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.add(websocket)

    def disconnect(self, websocket: WebSocket):
        self.active_connections.discard(websocket)

    async def broadcast(self, message: Dict[str, Any]):
        dead = []
        for connection in list(self.active_connections):
            try:
                await connection.send_json(message)
            except Exception:
                dead.append(connection)
        for d in dead:
            self.active_connections.discard(d)


manager = ConnectionManager()


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "service": "opencode-web-stream",
        "db": str(DEFAULT_DB_PATH),
        "db_exists": DEFAULT_DB_PATH.exists(),
        "ws_clients": len(manager.active_connections),
    }


@app.get("/api/search")
async def search_plocate(q: str = Query(..., min_length=1), limit: int = 30):
    results = indexer.fast_plocate(q, limit=limit)
    return {"query": q, "count": len(results), "results": results}


@app.get("/api/resolve")
async def resolve_phonetics(q: str = Query(..., min_length=1)):
    return resolver.resolve_with_certainty(q)


@app.post("/api/learn")
async def learn_alias(req: LearnAliasRequest):
    if not req.phrase_heard.strip() or not req.canonical_target.strip():
        raise HTTPException(status_code=400, detail="phrase_heard and canonical_target cannot be empty.")
    success = indexer.learn_alias(req.phrase_heard, req.canonical_target, req.confidence or 1.0)
    if not success:
        raise HTTPException(status_code=500, detail="Failed to persist learned alias.")
    return {"status": "learned"}


@app.get("/api/aliases")
async def list_aliases():
    aliases = indexer.get_learned_aliases()
    return {"count": len(aliases), "aliases": aliases}


@app.post("/api/agent/streamer_session")
async def bind_streamer_session(bind: StreamerSessionBind):
    streamer_sessions[bind.main_session] = bind.streamer_session
    logger.info(f"Bound streamer session {bind.streamer_session} to main session {bind.main_session}")
    return {"status": "ok"}


class FinalSummaryRequest(BaseModel):
    summary_text: Optional[str] = None
    session_id: Optional[str] = None
    model: Optional[str] = None
    agent: Optional[str] = None


@app.post("/api/agent/progress")
async def report_progress(step: ProgressStep):
    conversational_text = (step.summary or "").strip()
    if not conversational_text:
        return {"status": "ignored", "step_id": step.step_id, "reason": "no narrator text"}
    msg = {
        "type": "agent_progress",
        "data": {
            "step_id": step.step_id,
            "title": step.title,
            "tool": step.tool,
            "summary": conversational_text,
            "full_detail": step.full_detail,
            "status": step.status,
            "model": step.model,
            "agent": step.agent,
            "speech_text": conversational_text
        }
    }
    await manager.broadcast(msg)
    return {"status": "broadcasted", "step_id": step.step_id, "speech_text": conversational_text}


@app.post("/api/agent/summary")
async def report_summary(summary: FinalSummaryRequest):
    final_speech = (summary.summary_text or "").strip()
    if not final_speech:
        return {"status": "ignored", "type": "final_summary"}
    msg = {
        "type": "agent_final_summary",
        "data": {
            "summary_text": final_speech,
            "session_id": summary.session_id,
            "model": summary.model,
            "agent": summary.agent,
        }
    }
    await manager.broadcast(msg)
    return {"status": "broadcasted", "type": "final_summary"}


@app.post("/api/agent/redirect")
async def inject_trajectory(redirect: TrajectoryRedirect):
    resolution = resolver.resolve_with_certainty(redirect.instruction)
    normalized = resolution["resolved"]
    payload = {
        "type": "trajectory_redirect",
        "data": {
            "original_instruction": redirect.instruction,
            "normalized_instruction": normalized,
            "target_session": redirect.target_session,
            "interrupt_current": redirect.interrupt_current,
        }
    }
    await manager.broadcast(payload)
    return {"status": "redirect_sent", "normalized": normalized}


async def intercept_voice_via_streamer(session_id: str, raw_text: str):
    """
    Sends the STT transcript to the Streamer LLM to decide the action:
    <IGNORE>, <DIRECT>, or <INJECT>.
    """
    streamer_id = streamer_sessions.get(session_id)
    if not streamer_id:
        logger.warning(f"No streamer session found for {session_id}, falling back to raw injection.")
        return "<INJECT> " + raw_text
    
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.post(
                f"http://127.0.0.1:40977/api/session/messages",
                json={
                    "path": {"id": streamer_id},
                    "body": {"message": f"[VOICE_INTERCEPT]\n{raw_text}"}
                }
            )
            resp.raise_for_status()
            data = resp.json()
            parts = data.get("data", {}).get("parts", [])
            text_response = " ".join([p["text"] for p in parts if p.get("type") == "text"]).strip()
            return text_response
    except Exception as e:
        logger.error(f"Failed to intercept voice via streamer LLM: {e}")
        return "<INJECT> " + raw_text


@app.websocket("/ws/stream")
async def websocket_endpoint(websocket: WebSocket):
    await manager.connect(websocket)
    try:
        await websocket.send_json({
            "type": "handshake",
            "message": "OpenCode Web Stream Connected",
            "db_path": str(DEFAULT_DB_PATH)
        })

        while True:
            data = await websocket.receive_json()
            msg_type = data.get("type")

            if msg_type == "voice_transcript":
                raw_text = data.get("text", "")
                is_final = data.get("is_final", False)
                session_id = data.get("session_id", "")
                
                # Echo logic (fast local resolution for interim feedback)
                resolution = resolver.resolve_with_certainty(raw_text)
                await websocket.send_json({
                    "type": "voice_transcript_echo",
                    "raw": raw_text,
                    "normalized": resolution["resolved"],
                    "is_final": is_final,
                    "needs_clarification": resolution.get("needs_clarification", False),
                    "unknown_terms": resolution.get("unknown_terms", []),
                })

                # If it's final and it's a barge-in (user spoke to send a command)
                if is_final and data.get("barge_in"):
                    # 1. Route to Streamer LLM
                    streamer_response = await intercept_voice_via_streamer(session_id, raw_text)
                    
                    # 2. Parse Streamer Tokens
                    if "<IGNORE>" in streamer_response:
                        logger.info("Streamer ignored STT input (noise/hesitation).")
                        continue
                        
                    if "<DIRECT>" in streamer_response:
                        direct_ans = streamer_response.split("<DIRECT>")[1].strip()
                        await manager.broadcast({
                            "type": "agent_progress",
                            "data": {
                                "step_id": "direct_voice_reply",
                                "title": "Streamer Reply",
                                "summary": direct_ans,
                                "speech_text": direct_ans,
                                "status": "completed"
                            }
                        })
                        continue
                        
                    if "<INJECT>" in streamer_response:
                        inject_part = streamer_response.split("<INJECT>")[1].split("<SPEAK>")[0].strip()
                        speak_part = streamer_response.split("<SPEAK>")[1].strip() if "<SPEAK>" in streamer_response else "Bien reçu."
                        
                        # Forward the corrected text to the main agent composer
                        await manager.broadcast({
                            "type": "trajectory_redirect",
                            "data": {
                                "original_instruction": raw_text,
                                "normalized_instruction": inject_part,
                                "interrupt_current": True
                            }
                        })
                        # Speak the vocal acknowledgement
                        await manager.broadcast({
                            "type": "agent_progress",
                            "data": {
                                "step_id": "inject_ack",
                                "title": "Streamer Intercept",
                                "summary": speak_part,
                                "speech_text": speak_part,
                                "status": "completed"
                            }
                        })

            elif msg_type == "ping":
                await websocket.send_json({"type": "pong"})

            elif msg_type == "resolve_query":
                q = data.get("query", "")
                res = resolver.resolve_with_certainty(q)
                await websocket.send_json({
                    "type": "resolve_result",
                    "query": q,
                    "normalized": res["resolved"]
                })

    except WebSocketDisconnect:
        manager.disconnect(websocket)
    except Exception as e:
        logger.error(f"WebSocket error: {e}")
        manager.disconnect(websocket)


def main():
    import uvicorn
    uvicorn.run("server:app", host="0.0.0.0", port=8765, log_level="info")

if __name__ == "__main__":
    main()
