"""인증 사용자별 고비용 API 슬라이딩 윈도우 레이트리밋."""

import math
import os
import threading
import time
from collections import defaultdict, deque
from typing import Callable, Dict, Tuple

from fastapi import HTTPException, status


RatePolicy = Tuple[int, float]


def _positive_int_env(name: str, default: int) -> int:
    try:
        value = int(os.getenv(name, str(default)))
    except ValueError:
        return default
    return value if value > 0 else default


DEFAULT_RATE_POLICIES: Dict[str, RatePolicy] = {
    "chat": (_positive_int_env("CHAT_RATE_LIMIT_REQUESTS", 30), 60.0),
    "translate": (_positive_int_env("TRANSLATE_RATE_LIMIT_REQUESTS", 120), 60.0),
    "upload": (_positive_int_env("UPLOAD_RATE_LIMIT_REQUESTS", 10), 3600.0),
}


class SlidingWindowRateLimiter:
    def __init__(
        self,
        policies: Dict[str, RatePolicy],
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._policies = policies
        self._clock = clock
        self._requests = defaultdict(deque)
        self._lock = threading.Lock()
        self._cleanup_interval = min(window for _, window in policies.values())
        self._next_cleanup_at = 0.0

    def _evict_stale_identities(self, now: float) -> None:
        if now < self._next_cleanup_at:
            return
        for key, timestamps in list(self._requests.items()):
            _, window_seconds = self._policies[key[0]]
            cutoff = now - window_seconds
            while timestamps and timestamps[0] <= cutoff:
                timestamps.popleft()
            if not timestamps:
                del self._requests[key]
        self._next_cleanup_at = now + self._cleanup_interval

    def check(self, scope: str, identity: str) -> None:
        limit, window_seconds = self._policies[scope]
        now = self._clock()
        cutoff = now - window_seconds
        key = (scope, identity)

        with self._lock:
            self._evict_stale_identities(now)
            timestamps = self._requests[key]
            while timestamps and timestamps[0] <= cutoff:
                timestamps.popleft()

            if len(timestamps) >= limit:
                retry_after = max(1, math.ceil(timestamps[0] + window_seconds - now))
                raise HTTPException(
                    status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                    detail="요청이 너무 많습니다. 잠시 후 다시 시도해주세요.",
                    headers={"Retry-After": str(retry_after)},
                )

            timestamps.append(now)

    def reset(self) -> None:
        with self._lock:
            self._requests.clear()


request_rate_limiter = SlidingWindowRateLimiter(DEFAULT_RATE_POLICIES)


def enforce_rate_limit(scope: str, username: str) -> None:
    request_rate_limiter.check(scope, username)
