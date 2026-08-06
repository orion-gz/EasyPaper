from pydantic import BaseModel, Field
from typing import Dict, List


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


# --- 1. Interaction Quality Calculation ---
def calculate_interaction_quality(interaction: InteractionSummary) -> float:
    """Calculates weighted interaction quality score from raw counts."""
    return (
        interaction.scroll * 0.1
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
    total_confidence_sum = 0.0

    if not page_sessions:
        return {}, 0, 0.0

    # A client should send one cumulative entry per page, but consolidating here
    # prevents duplicate page entries from inflating verified-page counts.
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

        # 2) Very short active time
        if active_time < 10.0:
            final_score = min(final_score, 15.0)

        # 3) AFK long time without interaction or scroll
        if active_time > 900.0 and iq == 0.0 and scroll_cov < 0.3:
            final_score = min(final_score, 35.0)

        final_score = round(max(0.0, min(100.0, final_score)), 1)
        page_scores[page_num] = final_score

        if final_score >= 50.0:
            verified_count += 1
        total_confidence_sum += final_score

    avg_confidence = round(total_confidence_sum / len(consolidated), 1) if consolidated else 0.0
    return page_scores, verified_count, avg_confidence


# --- 3. Reading Depth Analyzer ---
def determine_reading_depth(
    active_reading_time: float,
    verified_pages_count: int,
    total_pages: int,
    reading_score: float
) -> str:
    """
    Determines Reading Depth state: Opened -> Browsing -> Reading -> Deep Reading -> Completed
    """
    total_content = max(1, total_pages)
    verified_ratio = verified_pages_count / total_content

    if active_reading_time < 30.0 and verified_pages_count == 0:
        return "Opened"
    if verified_ratio >= 0.8 or reading_score >= 85.0:
        return "Completed"
    if verified_ratio >= 0.5 or (verified_pages_count >= 3 and reading_score >= 60.0):
        return "Deep Reading"
    if verified_ratio >= 0.2 or (verified_pages_count >= 2 and reading_score >= 40.0):
        return "Reading"
    return "Browsing"


# --- 4. Reading Score Engine ---
def calculate_reading_score(
    verified_pages_count: int,
    total_pages: int,
    reading_confidence: float,
    reading_depth: str,
    total_interaction_quality: float
) -> float:
    """
    Calculates final overall Reading Score (0~100) using rule-based feature weighting.
    """
    total_content = max(1, total_pages)
    verified_ratio = min(1.0, verified_pages_count / total_content)

    depth_weights = {
        "Opened": 10.0,
        "Browsing": 30.0,
        "Reading": 60.0,
        "Deep Reading": 85.0,
        "Completed": 100.0,
    }
    depth_score = depth_weights.get(reading_depth, 10.0)

    # 40% Verified ratio + 25% Confidence + 20% Depth + 15% Interaction Quality
    score = (
        0.40 * (verified_ratio * 100.0)
        + 0.25 * reading_confidence
        + 0.20 * depth_score
        + 0.15 * min(100.0, total_interaction_quality * 5.0)
    )

    return round(max(0.0, min(100.0, score)), 1)


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
    user_ema: float
) -> ReadingAnalyticsResult:
    total_pages = max(total_paper_pages, max([ps.page for ps in payload.pageSessions], default=1))

    page_scores, verified_count, avg_confidence = analyze_page_sessions(
        payload.pageSessions,
        user_ema,
        total_pages
    )

    summary_iq = calculate_interaction_quality(payload.interactionSummary)
    page_iq = sum(calculate_interaction_quality(ps.interaction) for ps in payload.pageSessions)
    # Each frontend event is recorded in both representations; do not double count it.
    total_iq = max(summary_iq, page_iq)

    depth = determine_reading_depth(payload.activeReadingTime, verified_count, total_pages, 0.0)
    for _ in range(3):
        reading_score = calculate_reading_score(verified_count, total_pages, avg_confidence, depth, total_iq)
        next_depth = determine_reading_depth(payload.activeReadingTime, verified_count, total_pages, reading_score)
        if next_depth == depth:
            break
        depth = next_depth
    reading_score = calculate_reading_score(verified_count, total_pages, avg_confidence, depth, total_iq)

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
    )
