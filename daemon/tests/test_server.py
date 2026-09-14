import pytest
from httpx import AsyncClient, ASGITransport
from server import app, DEFAULT_DB_PATH, indexer, resolver


@pytest.mark.asyncio
async def test_server_health_and_endpoints():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        # 1. Health check
        res = await ac.get("/health")
        assert res.status_code == 200
        data = res.json()
        assert data["status"] == "ok"
        assert data["service"] == "opencode-web-stream"

        # 2. Dynamic learning via /api/learn
        learn_res = await ac.post("/api/learn", json={
            "phrase_heard": "dex proxy",
            "canonical_target": "desk-proxy",
            "confidence": 1.0
        })
        assert learn_res.status_code == 200
        ldata = learn_res.json()
        assert ldata["status"] == "learned"
        assert ldata["phrase_heard"] == "dex proxy"
        assert ldata["canonical_target"] == "desk-proxy"

        # 3. Dynamic resolve endpoint verifying learned alias
        res_resolve = await ac.get("/api/resolve?q=lance dex proxy")
        assert res_resolve.status_code == 200
        rdata = res_resolve.json()
        assert "desk-proxy" in rdata["resolved"]
        assert "needs_clarification" in rdata
        assert rdata["needs_clarification"] is False

        # 4. Unknown entity triggering needs_clarification
        res_unknown = await ac.get("/api/resolve?q=active le module_completement_inconnu_xyz")
        assert res_unknown.status_code == 200
        udata = res_unknown.json()
        assert udata["needs_clarification"] is True
        assert len(udata["unknown_terms"]) > 0

        # 5. Fast plocate endpoint
        res_search = await ac.get("/api/search?q=indexer.py")
        assert res_search.status_code == 200
        sdata = res_search.json()
        assert "results" in sdata

        # 6. Agent progress broadcast endpoint
        res_prog = await ac.post("/api/agent/progress", json={
            "step_id": "step-123",
            "title": "Running unit tests",
            "tool": "bash",
            "summary": "Executed test cases with zero errors",
            "full_detail": "Detailed stdout log...",
            "status": "completed"
        })
        assert res_prog.status_code == 200
        pdata = res_prog.json()
        assert pdata["status"] == "broadcasted"
        assert pdata["step_id"] == "step-123"

        # 7. Agent trajectory redirect endpoint
        res_redir = await ac.post("/api/agent/redirect", json={
            "instruction": "stop et verifie avec dex proxy",
            "interrupt_current": True
        })
        assert res_redir.status_code == 200
        rdata = res_redir.json()
        assert rdata["status"] == "redirect_sent"
        assert "desk-proxy" in rdata["normalized"]
