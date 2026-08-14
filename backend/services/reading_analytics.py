from pydantic import BaseModel, Field
from typing import Dict, List


READING_ANALYTICS_VERSION = 3
MIN_MEANINGFUL_PAGE_SECONDS = 10.0
SEMANTIC_INTERACTION_FIELDS = (
    "selection", "highlight", "underline", "memo", "question",
    "citationClick", "figureClick", "tableClick", "equationClick",
)


class InteractionSummary(BaseModel):
    scroll: int = Field(default=0, ge=0)
    selection: int = Field(default=0, ge=0)
    highlight: int = Field(default=0, ge=0)
    underline: int = Field(default=0, ge=0)
    memo: int = Field(default=0, ge=0)
    question: int = Field(default=0, ge=0)
    citationClick: int = Field(default=0, ge=0)
    figureClick: int = Field(default=0, ge=0)
    tableClick: int = Field(default=0, ge=0)
    equationClick: int = Field(default=0, ge=0)


class PageSession(BaseModel):
    page: int = Field(ge=1)
    enterTime: float = Field(default=0, ge=0)
    leaveTime: float = Field(default=0, ge=0)
    visibleTime: float = Field(default=0, ge=0)
    activeTime: float = Field(default=0, ge=0)
    scrollCoverage: float = Field(default=0.0, ge=0.0, le=1.0)
    interaction: InteractionSummary = Field(default_factory=InteractionSummary)


class ReadingSessionPayload(BaseModel):
    sessionId: str
    paperId: str
    version: int = Field(default=0, ge=0)
    currentPage: int = Field(default=1, ge=1)
    activeReadingTime: float = Field(default=0.0, ge=0)
    pageSessions: List[PageSession] = Field(default_factory=list)
    interactionSummary: InteractionSummary = Field(default_factory=InteractionSummary)


class ReadingAnalyticsResult(BaseModel):
    sessionId: str
    paperId: str
    readingScore: float  # 0~100
    readingConfidence: float  # 0~100
    readingDepth: str  # Opened | Browsing | Reading | Deep Reading | Completed
    verifiedPagesCount: int
    totalPages: int
    activeReadingTime: float
    pageScores: Dict[int, float] = Field(default_factory=dict)
    readingActivity: str  # ignored | browsed | read
    minimumEvidenceTime: float


class PaperReadingAnalyticsResult(BaseModel):
    readingScore: float
    readingConfidence: float
    readingDepth: str
    verifiedPagesCount: int
    meaningfulPagesCount: int
    totalPages: int
    activeReadingTime: float
    pageScores: Dict[int, float] = Field(default_factory=dict)


# --- 1. Interaction Quality Calculation ---
def calculate_interaction_quality(interaction: InteractionSummary) -> float:
    """Calculate interaction evidence without letting raw scroll events dominate."""
    return (
        min(interaction.scroll, 10) * 0.1
        + interaction.selection * 0.5
        + interaction.highlight * 3.0
        + interaction.underline * 3.0
        + interaction.memo * 4.0
        + interaction.question * 4.0
        + interaction.citationClick * 2.0
        + interaction.figureClick * 2.0
        + interaction.tableClick * 2.0
        + interaction.equationClick * 2.0
    )


def has_semantic_interaction(interaction: InteractionSummary) -> bool:
    """Return whether a page has an intentional research interaction."""
    return any(getattr(interaction, field_name) > 0 for field_name in SEMANTIC_INTERACTION_FIELDS)


def is_meaningful_page_session(page_session: PageSession) -> bool:
    """Exclude pass-through pages while preserving short figure/reference visits."""
    return (
        page_session.activeTime >= MIN_MEANINGFUL_PAGE_SECONDS
        or has_semantic_interaction(page_session.interaction)
    )


def count_meaningful_page_sessions(page_sessions: List[PageSession]) -> int:
    return len({ps.page for ps in page_sessions if is_meaningful_page_session(ps)})


def consolidate_page_sessions(page_sessions: List[PageSession]) -> Dict[int, PageSession]:
    """Merge repeated payload entries into one cumulative record per page."""
    consolidated: Dict[int, PageSession] = {}
    for ps in page_sessions:
        previous = consolidated.get(ps.page)
        if previous is None:
            consolidated[ps.page] = ps.model_copy(deep=True)
            continue
        positive_enter_times = [v for v in (previous.enterTime, ps.enterTime) if v > 0]
        previous.enterTime = min(positive_enter_times) if positive_enter_times else 0
        previous.leaveTime = max(previous.leaveTime, ps.leaveTime)
        previous.visibleTime += ps.visibleTime
        previous.activeTime += ps.activeTime
        previous.scrollCoverage = max(previous.scrollCoverage, ps.scrollCoverage)
        for field_name in InteractionSummary.model_fields:
            setattr(
                previous.interaction,
                field_name,
                getattr(previous.interaction, field_name) + getattr(ps.interaction, field_name),
            )
    return consolidated


def calculate_minimum_evidence_time(user_ema: float) -> float:
    """Personalized active-time floor for reliable reading evidence."""
    return round(max(45.0, min(120.0, user_ema * 0.15)), 1)


def has_suspicious_reading_pattern(page_sessions: List[PageSession]) -> bool:
    """Detect known AFK patterns that must not qualify as reading."""
    for page_session in page_sessions:
        interaction_quality = calculate_interaction_quality(page_session.interaction)
        if (
            page_session.activeTime > 900.0
            and interaction_quality == 0.0
            and page_session.scrollCoverage < 0.3
        ):
            return True
    return False


def classify_reading_activity(
    active_reading_time: float,
    verified_pages_count: int,
    reading_confidence: float,
    user_ema: float,
    page_sessions: List[PageSession],
) -> tuple[str, float]:
    """Classify Timeline activity using multiple independent reading signals."""
    minimum_time = calculate_minimum_evidence_time(user_ema)
    qualifies_as_read = (
        active_reading_time >= minimum_time
        and verified_pages_count >= 1
        and reading_confidence >= 50.0
        and not has_suspicious_reading_pattern(page_sessions)
    )
    if qualifies_as_read:
        return "read", minimum_time
    if active_reading_time >= 30.0 or verified_pages_count >= 1:
        return "browsed", minimum_time
    return "ignored", minimum_time


# --- 2. Feature Extraction & Page Analyzer ---
def analyze_page_sessions(
    page_sessions: List[PageSession],
    expected_page_time: float,
    total_pages: int
) -> tuple[Dict[int, float], int, float]:
    """
    Analyzes page sessions using feature extraction and constraint rules (kill-switches).
    Returns (page_scores dict, verified_pages_count, average_page_confidence).
    """
    page_scores: Dict[int, float] = {}
    verified_count = 0
    weighted_confidence_sum = 0.0
    confidence_weight_sum = 0.0

    if not page_sessions:
        return {}, 0, 0.0

    # A client should send one cumulative entry per page, but consolidating here
    # prevents duplicate page entries from inflating verified-page counts.
    consolidated = consolidate_page_sessions(page_sessions)

    for ps in consolidated.values():
        page_num = ps.page
        scroll_cov = max(0.0, min(1.0, ps.scrollCoverage))
        active_time = max(0.0, ps.activeTime)

        # AFK / Idle capping decay for long active time without interaction
        if active_time > 1800.0:  # > 30 mins
            capped_active_time = 600.0 + (active_time - 600.0) * 0.1
        else:
            capped_active_time = active_time

        iq = calculate_interaction_quality(ps.interaction)

        # Base Score Components
        # Time score: up to 50 pts
        time_score = min(50.0, (capped_active_time / max(1.0, expected_page_time)) * 50.0)
        # Scroll coverage score: up to 30 pts
        scroll_score = scroll_cov * 30.0
        # Interaction score: up to 20 pts
        interaction_score = min(20.0, iq * 5.0)

        raw_score = time_score + scroll_score + interaction_score

        # Constraint Rules (Kill-Switch)
        final_score = raw_score
        # 1) Extremely low scroll coverage without meaningful interaction
        if scroll_cov < 0.2 and iq < 1.0:
            final_score = min(final_score, 25.0)

        # 2) Retain pass-through pages for diagnostics without treating an
        # intentional figure/table/reference visit as failed reading evidence.
        if active_time < MIN_MEANINGFUL_PAGE_SECONDS and not has_semantic_interaction(ps.interaction):
            final_score = min(final_score, 15.0)

        # 3) AFK long time without interaction or scroll
        if active_time > 900.0 and iq == 0.0 and scroll_cov < 0.3:
            final_score = min(final_score, 35.0)

        final_score = round(max(0.0, min(100.0, final_score)), 1)
        page_scores[page_num] = final_score

        if final_score >= 50.0:
            verified_count += 1
        if is_meaningful_page_session(ps):
            weight = max(
                MIN_MEANINGFUL_PAGE_SECONDS,
                min(active_time, max(MIN_MEANINGFUL_PAGE_SECONDS, expected_page_time)),
            )
            weighted_confidence_sum += final_score * weight
            confidence_weight_sum += weight

    avg_confidence = round(weighted_confidence_sum / confidence_weight_sum, 1) if confidence_weight_sum else 0.0
    return page_scores, verified_count, avg_confidence


def build_page_evidence(
    page_sessions: List[PageSession],
    expected_page_time: float,
    total_pages: int,
) -> Dict[int, Dict[str, float]]:
    """Return persistable evidence for meaningful pages in one session."""
    consolidated = consolidate_page_sessions(page_sessions)
    page_scores, _, _ = analyze_page_sessions(
        list(consolidated.values()), expected_page_time, total_pages,
    )
    evidence: Dict[int, Dict[str, float]] = {}
    for page, page_session in consolidated.items():
        if not is_meaningful_page_session(page_session):
            continue
        evidence[page] = {
            "score": page_scores[page],
            "evidence_time": max(
                MIN_MEANINGFUL_PAGE_SECONDS,
                min(
                    page_session.activeTime,
                    max(MIN_MEANINGFUL_PAGE_SECONDS, expected_page_time),
                ),
            ),
            "interaction_quality": calculate_interaction_quality(page_session.interaction),
        }
    return evidence


# --- 3. Reading Depth Analyzer ---
def determine_reading_depth(
    active_reading_time: float,
    verified_pages_count: int,
    total_pages: int,
    reading_score: float,
    meaningful_pages_count: int | None = None,
) -> str:
    """
    Determines Reading Depth state: Opened -> Browsing -> Reading -> Deep Reading -> Completed
    """
    total_content = max(1, total_pages)
    verified_ratio = verified_pages_count / total_content
    meaningful_total = max(1, meaningful_pages_count if meaningful_pages_count is not None else total_pages)
    evidence_ratio = verified_pages_count / meaningful_total

    if active_reading_time < 30.0 and verified_pages_count == 0:
        return "Opened"
    if verified_ratio >= 0.8:
        return "Completed"
    if verified_ratio >= 0.5 or (verified_pages_count >= 3 and evidence_ratio >= 0.5):
        return "Deep Reading"
    if verified_ratio >= 0.2 or evidence_ratio >= 0.5 or (verified_pages_count >= 2 and reading_score >= 40.0):
        return "Reading"
    return "Browsing"


# --- 4. Reading Score Engine ---
def calculate_reading_score(
    verified_pages_count: int,
    total_pages: int,
    reading_confidence: float,
    reading_depth: str,
    total_interaction_quality: float,
    meaningful_pages_count: int | None = None,
) -> float:
    """
    Calculates final overall Reading Score (0~100) using rule-based feature weighting.
    """
    total_content = max(1, total_pages)
    verified_ratio = min(1.0, verified_pages_count / total_content)
    meaningful_total = max(1, meaningful_pages_count if meaningful_pages_count is not None else total_pages)
    evidence_ratio = min(1.0, verified_pages_count / meaningful_total)

    depth_weights = {
        "Opened": 10.0,
        "Browsing": 30.0,
        "Reading": 60.0,
        "Deep Reading": 85.0,
        "Completed": 100.0,
    }
    depth_score = depth_weights.get(reading_depth, 10.0)

    # Whole-paper coverage and evidence quality are separate signals.
    score = (
        0.15 * (verified_ratio * 100.0)
        + 0.20 * (evidence_ratio * 100.0)
        + 0.30 * reading_confidence
        + 0.20 * depth_score
        + 0.15 * min(100.0, total_interaction_quality * 5.0)
    )

    return round(max(0.0, min(100.0, score)), 1)


def calculate_paper_reading_analytics(
    page_evidence: Dict[int, Dict[str, float]],
    total_pages: int,
    active_reading_time: float,
    previous_reading_score: float = 0.0,
    previous_reading_depth: str = "Opened",
) -> PaperReadingAnalyticsResult:
    """Calculate cumulative paper achievement from each page's strongest evidence."""
    page_scores = {
        int(page): round(max(0.0, min(100.0, evidence.get("score", 0.0))), 1)
        for page, evidence in page_evidence.items()
    }
    meaningful_count = len(page_scores)
    verified_count = sum(score >= 50.0 for score in page_scores.values())
    confidence_weight = sum(
        max(MIN_MEANINGFUL_PAGE_SECONDS, evidence.get("evidence_time", 0.0))
        for evidence in page_evidence.values()
    )
    weighted_confidence = sum(
        page_scores[int(page)]
        * max(MIN_MEANINGFUL_PAGE_SECONDS, evidence.get("evidence_time", 0.0))
        for page, evidence in page_evidence.items()
    )
    confidence = round(weighted_confidence / confidence_weight, 1) if confidence_weight else 0.0
    total_iq = sum(
        max(0.0, evidence.get("interaction_quality", 0.0))
        for evidence in page_evidence.values()
    )

    depth = determine_reading_depth(
        active_reading_time, verified_count, total_pages, 0.0, meaningful_count,
    )
    for _ in range(3):
        score = calculate_reading_score(
            verified_count, total_pages, confidence, depth, total_iq, meaningful_count,
        )
        next_depth = determine_reading_depth(
            active_reading_time, verified_count, total_pages, score, meaningful_count,
        )
        if next_depth == depth:
            break
        depth = next_depth
    score = calculate_reading_score(
        verified_count, total_pages, confidence, depth, total_iq, meaningful_count,
    )

    depth_rank = {
        "Opened": 0,
        "Browsing": 1,
        "Reading": 2,
        "Deep Reading": 3,
        "Completed": 4,
    }
    score = round(max(previous_reading_score, score), 1)
    if depth_rank.get(previous_reading_depth, 0) > depth_rank.get(depth, 0):
        depth = previous_reading_depth

    return PaperReadingAnalyticsResult(
        readingScore=score,
        readingConfidence=confidence,
        readingDepth=depth,
        verifiedPagesCount=verified_count,
        meaningfulPagesCount=meaningful_count,
        totalPages=max(1, total_pages),
        activeReadingTime=max(0.0, active_reading_time),
        pageScores=page_scores,
    )


# --- 5. EMA Learning Engine ---
def update_user_ema(
    current_ema: float,
    session_count: int,
    session_active_time: float,
    visited_pages_count: int
) -> tuple[float, int]:
    """
    Updates user's Exponential Moving Average (EMA) of reading speed per page.
    Includes Cold-Start protection: limits adjustment rate when session_count < 5.
    Default EMA: 600.0s (10 min / page).
    """
    if session_active_time < 10.0 or visited_pages_count <= 0:
        return current_ema, session_count

    session_pace = session_active_time / visited_pages_count
    # Clamp pace between 60s (1 min) and 1800s (30 min)
    clamped_pace = max(60.0, min(1800.0, session_pace))

    # Cold Start adjustment rate
    if session_count < 5:
        alpha = 0.05  # Slow learning rate during cold start
    else:
        alpha = 0.15  # Normal learning rate

    new_ema = (alpha * clamped_pace) + ((1.0 - alpha) * current_ema)
    new_ema = round(max(60.0, min(1800.0, new_ema)), 1)

    return new_ema, session_count + 1


# --- Main Engine Runner ---
def process_reading_analytics(
    payload: ReadingSessionPayload,
    total_paper_pages: int,
    user_ema: float,
    previous_reading_score: float = 0.0,
) -> ReadingAnalyticsResult:
    total_pages = max(total_paper_pages, max([ps.page for ps in payload.pageSessions], default=1))

    page_scores, verified_count, avg_confidence = analyze_page_sessions(
        payload.pageSessions,
        user_ema,
        total_pages
    )
    meaningful_pages_count = count_meaningful_page_sessions(payload.pageSessions)

    summary_iq = calculate_interaction_quality(payload.interactionSummary)
    page_iq = sum(
        calculate_interaction_quality(ps.interaction)
        for ps in payload.pageSessions if is_meaningful_page_session(ps)
    )
    # Each frontend event is recorded in both representations; do not double count it.
    total_iq = max(summary_iq, page_iq)

    depth = determine_reading_depth(
        payload.activeReadingTime, verified_count, total_pages, 0.0, meaningful_pages_count,
    )
    for _ in range(3):
        reading_score = calculate_reading_score(
            verified_count, total_pages, avg_confidence, depth, total_iq, meaningful_pages_count,
        )
        next_depth = determine_reading_depth(
            payload.activeReadingTime, verified_count, total_pages, reading_score, meaningful_pages_count,
        )
        if next_depth == depth:
            break
        depth = next_depth
    reading_score = calculate_reading_score(
        verified_count, total_pages, avg_confidence, depth, total_iq, meaningful_pages_count,
    )
    # Reading Score represents cumulative achievement within a session. A newly
    # opened page can temporarily lower confidence while it is still being read,
    # but it must not erase evidence already earned earlier in the same session.
    reading_score = round(max(previous_reading_score, reading_score), 1)
    reading_activity, minimum_evidence_time = classify_reading_activity(
        payload.activeReadingTime, verified_count, avg_confidence, user_ema, payload.pageSessions,
    )

    return ReadingAnalyticsResult(
        sessionId=payload.sessionId,
        paperId=payload.paperId,
        readingScore=reading_score,
        readingConfidence=avg_confidence,
        readingDepth=depth,
        verifiedPagesCount=verified_count,
        totalPages=total_pages,
        activeReadingTime=payload.activeReadingTime,
        pageScores=page_scores,
        readingActivity=reading_activity,
        minimumEvidenceTime=minimum_evidence_time,
    )
