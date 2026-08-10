import unittest
from services.reading_analytics import (
    InteractionSummary,
    PageSession,
    ReadingSessionPayload,
    process_reading_analytics,
    calculate_interaction_quality,
    analyze_page_sessions,
    determine_reading_depth,
    calculate_reading_score,
    calculate_minimum_evidence_time,
    classify_reading_activity,
    count_meaningful_page_sessions,
    update_user_ema,
)


class TestReadingAnalytics(unittest.TestCase):

    def test_interaction_quality(self):
        interaction = InteractionSummary(
            scroll=10,
            selection=2,
            highlight=1,
            memo=1,
            question=1
        )
        # 10*0.1 + 2*0.5 + 1*3 + 1*4 + 1*4 = 1.0 + 1.0 + 3.0 + 4.0 + 4.0 = 13.0
        iq = calculate_interaction_quality(interaction)
        self.assertEqual(iq, 13.0)

    def test_page_analyzer_kill_switches(self):
        # Test low scroll coverage kill-switch
        ps1 = PageSession(
            page=1,
            activeTime=300.0,
            scrollCoverage=0.1,  # low scroll coverage < 0.2
            interaction=InteractionSummary(scroll=1)
        )
        page_scores, verified_count, avg_conf = analyze_page_sessions([ps1], 600.0, 10)
        self.assertLessEqual(page_scores[1], 25.0)
        self.assertEqual(verified_count, 0)

        # Test normal page reading -> verified
        ps2 = PageSession(
            page=2,
            activeTime=400.0,
            scrollCoverage=0.85,
            interaction=InteractionSummary(scroll=20, highlight=1, selection=2)
        )
        page_scores2, verified_count2, avg_conf2 = analyze_page_sessions([ps2], 600.0, 10)
        self.assertGreaterEqual(page_scores2[2], 50.0)
        self.assertEqual(verified_count2, 1)

    def test_reading_depth_transitions(self):
        depth_opened = determine_reading_depth(20.0, 0, 10, 0.0)
        self.assertEqual(depth_opened, "Opened")

        depth_browsing = determine_reading_depth(60.0, 1, 10, 15.0)
        self.assertEqual(depth_browsing, "Browsing")

        depth_reading = determine_reading_depth(300.0, 3, 10, 45.0)
        self.assertEqual(depth_reading, "Reading")

        depth_deep = determine_reading_depth(600.0, 6, 10, 70.0)
        self.assertEqual(depth_deep, "Deep Reading")

        depth_completed = determine_reading_depth(1200.0, 9, 10, 90.0)
        self.assertEqual(depth_completed, "Completed")

    def test_reading_score_engine(self):
        score = calculate_reading_score(
            verified_pages_count=8,
            total_pages=10,
            reading_confidence=80.0,
            reading_depth="Completed",
            total_interaction_quality=10.0
        )
        self.assertGreaterEqual(score, 70.0)
        self.assertLessEqual(score, 100.0)

    def test_ema_learning_cold_start(self):
        # Cold start session count < 5 -> alpha = 0.05
        init_ema = 600.0
        new_ema, count = update_user_ema(
            current_ema=init_ema,
            session_count=2,
            session_active_time=1200.0,
            visited_pages_count=2  # 600s / page pace
        )
        # Session pace 600s == init_ema, so ema stays 600.0
        self.assertEqual(new_ema, 600.0)
        self.assertEqual(count, 3)

        # Fast reading session
        new_ema_fast, count_fast = update_user_ema(
            current_ema=600.0,
            session_count=2,
            session_active_time=200.0,
            visited_pages_count=2  # 100s / page pace
        )
        # alpha = 0.05 -> 0.05*100 + 0.95*600 = 5 + 570 = 575.0
        self.assertEqual(new_ema_fast, 575.0)
        self.assertEqual(count_fast, 3)

    def test_minimum_evidence_time_is_personalized_and_bounded(self):
        self.assertEqual(calculate_minimum_evidence_time(100.0), 45.0)
        self.assertEqual(calculate_minimum_evidence_time(600.0), 90.0)
        self.assertEqual(calculate_minimum_evidence_time(1000.0), 120.0)

    def test_reading_activity_requires_independent_evidence(self):
        page = PageSession(
            page=1, activeTime=90.0, scrollCoverage=0.8,
            interaction=InteractionSummary(scroll=3),
        )
        self.assertEqual(
            classify_reading_activity(29.0, 0, 0.0, 600.0, [page])[0],
            "ignored",
        )
        self.assertEqual(
            classify_reading_activity(30.0, 0, 0.0, 600.0, [page])[0],
            "browsed",
        )
        self.assertEqual(
            classify_reading_activity(89.0, 1, 60.0, 600.0, [page])[0],
            "browsed",
        )
        self.assertEqual(
            classify_reading_activity(90.0, 1, 49.9, 600.0, [page])[0],
            "browsed",
        )
        self.assertEqual(
            classify_reading_activity(90.0, 1, 50.0, 600.0, [page])[0],
            "read",
        )

    def test_suspicious_afk_pattern_does_not_qualify_as_read(self):
        suspicious_page = PageSession(
            page=1, activeTime=901.0, scrollCoverage=0.1,
            interaction=InteractionSummary(),
        )
        activity, _ = classify_reading_activity(901.0, 1, 80.0, 600.0, [suspicious_page])
        self.assertEqual(activity, "browsed")

    def test_process_reading_analytics(self):
        payload = ReadingSessionPayload(
            sessionId="test-session-1",
            paperId="doc-123",
            version=1,
            currentPage=1,
            activeReadingTime=350.0,
            pageSessions=[
                PageSession(
                    page=1,
                    activeTime=180.0,
                    scrollCoverage=0.9,
                    interaction=InteractionSummary(highlight=1, scroll=15)
                ),
                PageSession(
                    page=2,
                    activeTime=170.0,
                    scrollCoverage=0.8,
                    interaction=InteractionSummary(memo=1, scroll=12)
                ),
            ],
            interactionSummary=InteractionSummary(highlight=1, memo=1, scroll=27)
        )

        res = process_reading_analytics(payload, total_paper_pages=5, user_ema=600.0)
        self.assertEqual(res.sessionId, "test-session-1")
        self.assertEqual(res.paperId, "doc-123")
        self.assertEqual(res.verifiedPagesCount, 2)
        self.assertIn(res.readingDepth, ["Reading", "Deep Reading"])
        self.assertGreater(res.readingScore, 0.0)
        self.assertEqual(res.readingActivity, "read")
        self.assertEqual(res.minimumEvidenceTime, 90.0)


    def test_brief_pass_through_pages_do_not_poison_confidence(self):
        pages = [
            PageSession(page=page, activeTime=1, scrollCoverage=0.05)
            for page in range(1, 7)
        ] + [
            PageSession(
                page=page, activeTime=600, scrollCoverage=0.8,
                interaction=InteractionSummary(scroll=10, highlight=1),
            )
            for page in range(7, 10)
        ]
        payload = ReadingSessionPayload(
            sessionId="targeted", paperId="paper", activeReadingTime=1806,
            pageSessions=pages,
            interactionSummary=InteractionSummary(scroll=30, highlight=3),
        )

        result = process_reading_analytics(payload, total_paper_pages=19, user_ema=600)

        self.assertEqual(count_meaningful_page_sessions(pages), 3)
        self.assertGreaterEqual(result.readingConfidence, 90.0)
        self.assertEqual(result.readingActivity, "read")
        self.assertEqual(result.readingDepth, "Deep Reading")
        self.assertGreaterEqual(result.readingScore, 70.0)

    def test_short_semantic_visit_remains_meaningful(self):
        page = PageSession(
            page=4, activeTime=3, scrollCoverage=0.1,
            interaction=InteractionSummary(figureClick=2),
        )
        scores, _, confidence = analyze_page_sessions([page], 600, 10)

        self.assertEqual(count_meaningful_page_sessions([page]), 1)
        self.assertEqual(confidence, scores[4])
        self.assertGreater(scores[4], 15.0)

    def test_scroll_interaction_is_capped(self):
        self.assertEqual(
            calculate_interaction_quality(InteractionSummary(scroll=1000)),
            calculate_interaction_quality(InteractionSummary(scroll=10)),
        )

    def test_duplicate_page_entries_are_consolidated(self):
        page = PageSession(
            page=1, activeTime=180.0, scrollCoverage=0.8,
            interaction=InteractionSummary(highlight=1),
        )
        scores, verified, confidence = analyze_page_sessions([page, page], 600.0, 10)
        self.assertEqual(list(scores), [1])
        self.assertEqual(verified, 1)
        self.assertEqual(confidence, scores[1])

    def test_session_and_page_interactions_are_not_double_counted(self):
        interaction = InteractionSummary(highlight=1)
        payload = ReadingSessionPayload(
            sessionId="session", paperId="paper", activeReadingTime=300,
            pageSessions=[PageSession(
                page=1, activeTime=300, scrollCoverage=0.8, interaction=interaction,
            )],
            interactionSummary=interaction,
        )
        result = process_reading_analytics(payload, total_paper_pages=10, user_ema=600)
        self.assertEqual(result.readingScore, 55.0)


def _analytics_payload(session_id, paper_id, version, active_time=60):
    return {
        "sessionId": session_id,
        "paperId": paper_id,
        "version": version,
        "currentPage": 1,
        "activeReadingTime": active_time,
        "pageSessions": [{
            "page": 1,
            "activeTime": active_time,
            "visibleTime": active_time,
            "scrollCoverage": 0.8,
            "interaction": {"highlight": 1},
        }],
        "interactionSummary": {"highlight": 1},
    }


def test_reading_session_merge_versioning_and_ema(test_client, isolated_dirs):
    db = isolated_dirs["db"]
    db.db_save_document(
        "paper-1", "testuser", "paper.pdf", "/x/paper.pdf", 5,
        {"title": "Extracted Paper Title"},
    )

    started = test_client.post(
        "/api/library/paper-1/reading-session/start", json={"totalPages": 5},
    )
    assert started.status_code == 200
    session_id = started.json()["sessionId"]

    heartbeat = test_client.post(
        "/api/library/paper-1/reading-session/heartbeat",
        json=_analytics_payload(session_id, "paper-1", 1),
    )
    assert heartbeat.status_code == 200
    assert db.db_get_user_reading_profile("testuser")["session_count"] == 0
    assert db.db_get_reading_time_stats("testuser")["total_seconds"] == 0

    timeline = test_client.get("/api/library/timeline").json()["events"]
    timeline_session = next(
        event for event in timeline
        if event.get("reading_session_id") == session_id
    )
    assert timeline_session["type"] == "browsed"
    assert timeline_session["verified_pages"] == 0
    assert timeline_session["verified_page_numbers"] == []
    assert db.db_get_reading_session(session_id, "testuser")["verified_pages_json"] == "[]"
    assert timeline_session["reading_score"] == heartbeat.json()["readingScore"]

    stale = test_client.post(
        "/api/library/paper-1/reading-session/heartbeat",
        json=_analytics_payload(session_id, "paper-1", 1, active_time=999),
    )
    assert stale.json() == {"stale": True, "version": 1}
    assert db.db_get_reading_session(session_id, "testuser")["active_reading_time"] == 60

    merged = test_client.post(
        "/api/library/paper-1/reading-session/start", json={"totalPages": 5},
    ).json()
    assert merged["merged"] is True
    assert merged["activeReadingTime"] == 60
    assert merged["pageSessions"][0]["page"] == 1
    assert merged["interactionSummary"]["highlight"] == 1

    ended = test_client.post(
        "/api/library/paper-1/reading-session/end",
        json=_analytics_payload(session_id, "paper-1", 2),
    )
    assert ended.status_code == 200
    assert db.db_get_user_reading_profile("testuser")["session_count"] == 1
    assert db.db_get_document("paper-1")["metadata"]["title"] == "Extracted Paper Title"

    repeated_end = test_client.post(
        "/api/library/paper-1/reading-session/end",
        json=_analytics_payload(session_id, "paper-1", 2),
    )
    assert repeated_end.json() == {"stale": True, "version": 2}
    assert db.db_get_user_reading_profile("testuser")["session_count"] == 1

    restarted = test_client.post(
        "/api/library/paper-1/reading-session/start", json={"totalPages": 5},
    ).json()
    assert restarted["merged"] is False
    assert restarted["sessionId"] != session_id


def test_reading_session_rejects_mismatched_paper_id(test_client, isolated_dirs):
    isolated_dirs["db"].db_save_document(
        "paper-1", "testuser", "paper.pdf", "/x/paper.pdf", 5, {},
    )
    response = test_client.post(
        "/api/library/paper-1/reading-session/heartbeat",
        json=_analytics_payload("session", "paper-2", 1),
    )
    assert response.status_code == 400


if __name__ == "__main__":
    unittest.main()
